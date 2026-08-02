#define _GNU_SOURCE

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/capability.h>
#include <linux/limits.h>
#include <sched.h>
#include <seccomp.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/ipc.h>
#include <sys/msg.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/sem.h>
#include <sys/shm.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#define GATEWAY_UID ((uid_t)65531)
#define DEMO_UID ((uid_t)65532)
#define DEMO_GID ((gid_t)65532)
#define WALL_LIMIT_SECONDS 62
#define TERMINATION_GRACE_MILLISECONDS 1000
#define ROOTFS_PATH "/srv/lit-shell-rootfs"
#define LAUNCHER_PATH "/usr/local/bin/lit-shell-sandbox"
#define SELF_TEST_MARKER "lit-shell-sandbox-self-test-ok\n"

static volatile sig_atomic_t forwarded_signal = 0;

static void write_all_best_effort(int descriptor, const char *data,
                                  size_t length) {
  while (length > 0) {
    const ssize_t written = write(descriptor, data, length);
    if (written <= 0) {
      return;
    }
    data += written;
    length -= (size_t)written;
  }
}

static void fail(const char *message) {
  const int saved_errno = errno;
  write_all_best_effort(STDERR_FILENO, "sandbox launcher: ", 18);
  write_all_best_effort(STDERR_FILENO, message, strlen(message));
  if (saved_errno != 0) {
    const char *detail = strerror(saved_errno);
    write_all_best_effort(STDERR_FILENO, ": ", 2);
    write_all_best_effort(STDERR_FILENO, detail, strlen(detail));
  }
  write_all_best_effort(STDERR_FILENO, "\n", 1);
  _exit(126);
}

static void fail_unresolved_seccomp_syscall(const char *name) {
  const char *prefix = "sandbox launcher: seccomp syscall is unavailable: ";
  write_all_best_effort(STDERR_FILENO, prefix, strlen(prefix));
  write_all_best_effort(STDERR_FILENO, name, strlen(name));
  write_all_best_effort(STDERR_FILENO, "\n", 1);
  _exit(126);
}

static void require_zero(int result, const char *message) {
  if (result != 0) {
    fail(message);
  }
}

static void forward_signal(int signal_number) {
  forwarded_signal = signal_number;
}

static void install_signal_handlers(void) {
  const int signals[] = {SIGHUP, SIGINT, SIGQUIT, SIGTERM};
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = forward_signal;
  sigemptyset(&action.sa_mask);
  for (size_t index = 0; index < sizeof(signals) / sizeof(signals[0]); index++) {
    require_zero(sigaction(signals[index], &action, NULL),
                 "could not install signal handler");
  }
  (void)signal(SIGPIPE, SIG_IGN);
  (void)signal(SIGTTOU, SIG_IGN);
}

static void verify_executable(int executable_fd) {
  struct stat details;
  require_zero(fstat(executable_fd, &details), "could not inspect launcher");
  if (!S_ISREG(details.st_mode) || details.st_uid != 0 ||
      (details.st_mode & (S_IWGRP | S_IWOTH)) != 0 ||
      (details.st_mode & S_ISUID) == 0) {
    errno = EPERM;
    fail("launcher ownership or mode is unsafe");
  }
}

static void set_limit(int resource, rlim_t soft, rlim_t hard,
                      const char *message) {
  const struct rlimit limit = {.rlim_cur = soft, .rlim_max = hard};
  require_zero(setrlimit(resource, &limit), message);
}

static void apply_resource_limits(void) {
  set_limit(RLIMIT_AS, 32U * 1024U * 1024U, 32U * 1024U * 1024U,
            "could not limit address space");
  set_limit(RLIMIT_CORE, 0, 0, "could not disable core dumps");
  set_limit(RLIMIT_CPU, 5, 6, "could not limit CPU time");
  set_limit(RLIMIT_FSIZE, 0, 0, "could not disable file writes");
  set_limit(RLIMIT_MEMLOCK, 0, 0, "could not disable memory locking");
  set_limit(RLIMIT_NOFILE, 32, 32, "could not limit open files");
  set_limit(RLIMIT_MSGQUEUE, 0, 0, "could not disable message queues");
  set_limit(RLIMIT_NPROC, 4, 4, "could not limit process count");
  set_limit(RLIMIT_SIGPENDING, 16, 16,
            "could not limit pending signals");
  set_limit(RLIMIT_STACK, 8U * 1024U * 1024U, 8U * 1024U * 1024U,
            "could not limit stack size");
}

static void close_extra_descriptors(void) {
#ifdef SYS_close_range
  if (syscall(SYS_close_range, 3U, ~0U, 0U) == 0) {
    return;
  }
  if (errno != ENOSYS) {
    fail("could not close inherited descriptors");
  }
#endif
  for (int descriptor = 3; descriptor < 1024; descriptor++) {
    (void)close(descriptor);
  }
}

static void drop_capability_bounding_set(void) {
  for (int capability = 0; capability <= CAP_LAST_CAP; capability++) {
    if (prctl(PR_CAPBSET_DROP, capability, 0, 0, 0) != 0 && errno != EINVAL) {
      fail("could not drop capability bounding set");
    }
  }
}

static void clear_capabilities(void) {
  struct __user_cap_header_struct header;
  struct __user_cap_data_struct data[2];
  memset(&header, 0, sizeof(header));
  memset(data, 0, sizeof(data));
  header.version = _LINUX_CAPABILITY_VERSION_3;
  header.pid = 0;
  if (syscall(SYS_capset, &header, data) != 0) {
    fail("could not clear process capabilities");
  }
}

static void install_seccomp_filter(void) {
  static const char *const denied_syscalls[] = {
      "accept",          "accept4",          "add_key",
      "bind",            "bpf",              "chroot",
      "clone3",
      "connect",         "delete_module",    "finit_module",
      "fsconfig",        "fsmount",          "fsopen",
      "fspick",          "getpeername",      "getsockname",
      "getsockopt",      "init_module",      "io_uring_enter",
      "io_uring_register", "io_uring_setup", "kcmp",
      "kexec_file_load", "kexec_load",       "keyctl",
      "listen",          "memfd_create",     "mount",
      "mq_getsetattr",   "mq_notify",        "mq_open",
      "mq_timedreceive", "mq_timedsend",     "mq_unlink",
      "move_mount",      "name_to_handle_at", "open_by_handle_at",
      "open_tree",       "perf_event_open",  "pidfd_getfd",
      "pidfd_open",      "pidfd_send_signal", "pivot_root",
      "process_vm_readv", "process_vm_writev", "ptrace",
      "reboot",          "recvfrom",         "recvmmsg",
      "recvmsg",         "request_key",      "sendmmsg",
      "sendmsg",         "sendto",           "setns",
      "semctl",          "semget",           "semop",
      "semtimedop",      "shmat",            "shmctl",
      "shmdt",           "shmget",            "msgctl",
      "msgget",          "msgrcv",           "msgsnd",
      "setsockopt",      "shutdown",         "socket",
      "socketpair",      "swapoff",          "swapon",
      "umount2",         "unshare",          "userfaultfd",
  };
  scmp_filter_ctx context = seccomp_init(SCMP_ACT_ALLOW);
  if (context == NULL) {
    fail("could not initialize seccomp");
  }
  for (size_t index = 0;
       index < sizeof(denied_syscalls) / sizeof(denied_syscalls[0]); index++) {
    const int syscall_number =
        seccomp_syscall_resolve_name(denied_syscalls[index]);
    if (syscall_number == __NR_SCMP_ERROR) {
      seccomp_release(context);
      fail_unresolved_seccomp_syscall(denied_syscalls[index]);
    }
    if (seccomp_rule_add(context, SCMP_ACT_ERRNO(EPERM), syscall_number, 0) !=
        0) {
      seccomp_release(context);
      fail("could not construct seccomp policy");
    }
  }

  const int clone_syscall = seccomp_syscall_resolve_name("clone");
  if (clone_syscall == __NR_SCMP_ERROR) {
    seccomp_release(context);
    fail_unresolved_seccomp_syscall("clone");
  }
  static const uint64_t namespace_flags[] = {
        CLONE_NEWCGROUP, CLONE_NEWIPC, CLONE_NEWNET, CLONE_NEWNS,
        CLONE_NEWPID,    CLONE_NEWUSER, CLONE_NEWUTS,
#ifdef CLONE_NEWTIME
        CLONE_NEWTIME,
#endif
  };
  for (size_t index = 0;
       index < sizeof(namespace_flags) / sizeof(namespace_flags[0]); index++) {
    if (seccomp_rule_add(
            context, SCMP_ACT_ERRNO(EPERM), clone_syscall, 1,
            SCMP_A0(SCMP_CMP_MASKED_EQ, namespace_flags[index],
                    namespace_flags[index])) != 0) {
      seccomp_release(context);
      fail("could not restrict clone namespaces");
    }
  }
  if (seccomp_load(context) != 0) {
    seccomp_release(context);
    fail("could not install seccomp policy");
  }
  seccomp_release(context);
}

static void install_environment(void) {
  if (clearenv() != 0) {
    fail("could not clear environment");
  }
  require_zero(setenv("HOME", "/home/demo", 1), "could not set HOME");
  require_zero(setenv("LANG", "C.UTF-8", 1), "could not set LANG");
  require_zero(setenv("LOGNAME", "demo", 1), "could not set LOGNAME");
  require_zero(setenv("PATH", "/bin:/usr/bin", 1), "could not set PATH");
  require_zero(setenv("PS1", "guest@lit-shell:\\w$ ", 1),
               "could not set PS1");
  require_zero(setenv("SHELL", "/bin/sh", 1), "could not set SHELL");
  require_zero(setenv("TERM", "xterm-256color", 1), "could not set TERM");
  require_zero(setenv("USER", "demo", 1), "could not set USER");
}

static void enter_sandbox(void) {
  errno = 0;
  if (nice(19) == -1 && errno != 0) {
    fail("could not lower shell priority");
  }
  apply_resource_limits();
  require_zero(chroot(ROOTFS_PATH), "could not enter sandbox root");
  require_zero(chdir("/home/demo"), "could not enter demo home");
  require_zero(setgroups(0, NULL), "could not clear supplementary groups");
  drop_capability_bounding_set();
  require_zero(setresgid(DEMO_GID, DEMO_GID, DEMO_GID),
               "could not drop group identity");
  require_zero(setresuid(DEMO_UID, DEMO_UID, DEMO_UID),
               "could not drop user identity");
  clear_capabilities();
  require_zero(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0),
               "could not set no-new-privileges");
  install_seccomp_filter();
  close_extra_descriptors();
}

static bool demo_process(const char *status_path) {
  FILE *status = fopen(status_path, "re");
  if (status == NULL) {
    return false;
  }
  char *line = NULL;
  size_t capacity = 0;
  bool matches = false;
  while (getline(&line, &capacity, status) >= 0) {
    unsigned int real = 0;
    unsigned int effective = 0;
    unsigned int saved = 0;
    unsigned int filesystem = 0;
    if (sscanf(line, "Uid:\t%u\t%u\t%u\t%u", &real, &effective, &saved,
               &filesystem) == 4) {
      matches = real == DEMO_UID || effective == DEMO_UID ||
                saved == DEMO_UID || filesystem == DEMO_UID;
      break;
    }
  }
  free(line);
  (void)fclose(status);
  return matches;
}

static void kill_demo_processes(void) {
  for (int pass = 0; pass < 3; pass++) {
    DIR *processes = opendir("/proc");
    if (processes == NULL) {
      fail("could not inspect process table");
    }
    struct dirent *entry;
    while ((entry = readdir(processes)) != NULL) {
      char *end = NULL;
      const long candidate = strtol(entry->d_name, &end, 10);
      if (*entry->d_name == '\0' || *end != '\0' || candidate <= 1 ||
          candidate > INT32_MAX) {
        continue;
      }
      char path[PATH_MAX];
      const int length = snprintf(path, sizeof(path), "/proc/%ld/status", candidate);
      if (length <= 0 || (size_t)length >= sizeof(path)) {
        continue;
      }
      if (demo_process(path)) {
        (void)kill((pid_t)candidate, SIGKILL);
      }
    }
    (void)closedir(processes);
    const struct timespec pause = {.tv_sec = 0, .tv_nsec = 50 * 1000 * 1000};
    (void)nanosleep(&pause, NULL);
  }
  while (waitpid(-1, NULL, WNOHANG) > 0) {
  }
}

static void verify_limit(int resource, rlim_t expected) {
  struct rlimit limit;
  require_zero(getrlimit(resource, &limit), "could not inspect resource limit");
  if (limit.rlim_cur != expected || limit.rlim_max != expected) {
    errno = ERANGE;
    fail("resource limit self-test failed");
  }
}

static void verify_limit_pair(int resource, rlim_t expected_soft,
                              rlim_t expected_hard) {
  struct rlimit limit;
  require_zero(getrlimit(resource, &limit), "could not inspect resource limit");
  if (limit.rlim_cur != expected_soft || limit.rlim_max != expected_hard) {
    errno = ERANGE;
    fail("resource limit self-test failed");
  }
}

static void verify_kernel_isolation(void) {
  errno = 0;
  const int shared_memory = shmget(IPC_PRIVATE, 4096, IPC_CREAT | 0600);
  if (shared_memory >= 0 || errno != EPERM) {
    if (shared_memory >= 0) {
      (void)shmctl(shared_memory, IPC_RMID, NULL);
    }
    errno = EPERM;
    fail("shared-memory isolation self-test failed");
  }

  errno = 0;
  const int message_queue = msgget(IPC_PRIVATE, IPC_CREAT | 0600);
  if (message_queue >= 0 || errno != EPERM) {
    if (message_queue >= 0) {
      (void)msgctl(message_queue, IPC_RMID, NULL);
    }
    errno = EPERM;
    fail("message-queue isolation self-test failed");
  }

  errno = 0;
  const int semaphore = semget(IPC_PRIVATE, 1, IPC_CREAT | 0600);
  if (semaphore >= 0 || errno != EPERM) {
    if (semaphore >= 0) {
      (void)semctl(semaphore, 0, IPC_RMID);
    }
    errno = EPERM;
    fail("semaphore isolation self-test failed");
  }

#ifdef SYS_clone3
  errno = 0;
  if (syscall(SYS_clone3, NULL, 0) >= 0 ||
      (errno != EPERM && errno != ENOSYS)) {
    errno = EPERM;
    fail("clone3 isolation self-test failed");
  }
#endif
}

static void run_self_test(void) {
  if (getuid() != DEMO_UID || geteuid() != DEMO_UID || getgid() != DEMO_GID ||
      getegid() != DEMO_GID) {
    errno = EPERM;
    fail("identity self-test failed");
  }
  gid_t groups[1];
  if (getgroups(1, groups) != 0) {
    errno = EPERM;
    fail("supplementary group self-test failed");
  }
  if (setuid(0) == 0 || seteuid(0) == 0) {
    errno = EPERM;
    fail("root-regain self-test failed");
  }
  if (access("/proc/self/environ", F_OK) == 0 ||
      access("/outside-canary", F_OK) == 0) {
    errno = EPERM;
    fail("chroot self-test failed");
  }
  const int file = open("/home/demo/self-test", O_CREAT | O_WRONLY, 0600);
  if (file >= 0) {
    (void)close(file);
    errno = EPERM;
    fail("read-only filesystem self-test failed");
  }
  const int network = socket(AF_INET, SOCK_STREAM, 0);
  if (network >= 0 || errno != EPERM) {
    if (network >= 0) {
      (void)close(network);
    }
    errno = EPERM;
    fail("network isolation self-test failed");
  }
  verify_kernel_isolation();
  verify_limit(RLIMIT_AS, 32U * 1024U * 1024U);
  verify_limit(RLIMIT_CORE, 0);
  verify_limit_pair(RLIMIT_CPU, 5, 6);
  verify_limit(RLIMIT_FSIZE, 0);
  verify_limit(RLIMIT_MEMLOCK, 0);
  verify_limit(RLIMIT_NOFILE, 32);
  verify_limit(RLIMIT_MSGQUEUE, 0);
  verify_limit(RLIMIT_NPROC, 4);
  verify_limit(RLIMIT_SIGPENDING, 16);
  require_zero(write(STDOUT_FILENO, SELF_TEST_MARKER,
                     sizeof(SELF_TEST_MARKER) - 1) ==
                       (ssize_t)(sizeof(SELF_TEST_MARKER) - 1)
                   ? 0
                   : -1,
               "could not report self-test result");
  _exit(0);
}

static void run_shell(void) {
  static const char banner[] =
      "\r\n"
      "lit-shell remote demo — isolated, read-only, no network, 60 seconds\r\n"
      "Try: id, env, ls /, cat /README.txt, uname -a, date\r\n\r\n";
  write_all_best_effort(STDOUT_FILENO, banner, sizeof(banner) - 1);
  char *const arguments[] = {(char *)"sh", (char *)"-i", NULL};
  execve("/bin/sh", arguments, environ);
  fail("could not start shell");
}

static int64_t monotonic_milliseconds(void) {
  struct timespec now;
  require_zero(clock_gettime(CLOCK_MONOTONIC, &now),
               "could not read monotonic clock");
  return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000 / 1000;
}

static void kill_child_and_wait(pid_t child, int *status) {
  (void)kill(-child, SIGKILL);
  (void)kill(child, SIGKILL);
  while (waitpid(child, status, 0) < 0) {
    if (errno == EINTR) {
      continue;
    }
    fail("could not reap terminated sandbox child");
  }
}

static int supervise(pid_t child) {
  const int64_t wall_deadline =
      monotonic_milliseconds() + WALL_LIMIT_SECONDS * 1000;
  int64_t termination_deadline = -1;
  int status = 0;
  while (true) {
    const pid_t result = waitpid(child, &status, WNOHANG);
    if (result == child) {
      break;
    }
    if (result < 0 && errno != EINTR) {
      fail("could not wait for sandbox child");
    }
    if (forwarded_signal != 0) {
      (void)kill(-child, forwarded_signal);
      (void)kill(child, forwarded_signal);
      forwarded_signal = 0;
      if (termination_deadline < 0) {
        termination_deadline =
            monotonic_milliseconds() + TERMINATION_GRACE_MILLISECONDS;
      }
    }
    const int64_t now = monotonic_milliseconds();
    if (termination_deadline >= 0 && now >= termination_deadline) {
      kill_child_and_wait(child, &status);
      break;
    }
    if (now >= wall_deadline) {
      kill_child_and_wait(child, &status);
      status = 124 << 8;
      break;
    }
    const struct timespec pause = {.tv_sec = 0, .tv_nsec = 100 * 1000 * 1000};
    (void)nanosleep(&pause, NULL);
  }
  kill_demo_processes();
  if (WIFEXITED(status)) {
    return WEXITSTATUS(status);
  }
  if (WIFSIGNALED(status)) {
    return 128 + WTERMSIG(status);
  }
  return 125;
}

int main(int argc, char **argv) {
  const bool self_test = argc == 2 && strcmp(argv[1], "--self-test") == 0;
  if (!self_test && argc != 1) {
    errno = EINVAL;
    fail("unsupported arguments");
  }
  if (getuid() != GATEWAY_UID || geteuid() != 0 || getegid() != GATEWAY_UID) {
    errno = EPERM;
    fail("setuid privilege boundary is unavailable");
  }
  umask(077);
  const int executable_fd = open(LAUNCHER_PATH, O_RDONLY | O_CLOEXEC);
  if (executable_fd < 0) {
    fail("could not open launcher lock");
  }
  verify_executable(executable_fd);
  if (flock(executable_fd, LOCK_EX | LOCK_NB) != 0) {
    fail("another sandbox is active");
  }
  require_zero(prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0),
               "could not become child subreaper");
  install_signal_handlers();
  kill_demo_processes();
  install_environment();

  const pid_t child = fork();
  if (child < 0) {
    fail("could not fork sandbox child");
  }
  if (child == 0) {
    require_zero(setpgid(0, 0), "could not isolate sandbox process group");
    if (isatty(STDIN_FILENO)) {
      require_zero(tcsetpgrp(STDIN_FILENO, getpid()),
                   "could not assign terminal process group");
    }
    enter_sandbox();
    if (self_test) {
      run_self_test();
    }
    run_shell();
  }

  (void)setpgid(child, child);
  const int result = supervise(child);
  (void)flock(executable_fd, LOCK_UN);
  (void)close(executable_fd);
  return result;
}
