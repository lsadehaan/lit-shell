from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

import pytest

PYTHON_PROJECT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="session")
def built_distributions(
    tmp_path_factory: pytest.TempPathFactory,
) -> tuple[Path, Path]:
    workspace = tmp_path_factory.mktemp("distributions")
    source_dir = workspace / "source"
    output_dir = workspace / "dist"
    shutil.copytree(
        PYTHON_PROJECT,
        source_dir,
        ignore=shutil.ignore_patterns(
            ".pytest_cache", "__pycache__", "build", "*.egg-info"
        ),
    )
    output_dir.mkdir()
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "build",
            "--sdist",
            "--wheel",
            "--outdir",
            str(output_dir),
            str(source_dir),
        ],
        cwd=workspace,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    wheels = list(output_dir.glob("lit_shell-*.whl"))
    source_distributions = list(output_dir.glob("lit_shell-*.tar.gz"))
    assert len(wheels) == 1
    assert len(source_distributions) == 1
    return wheels[0], source_distributions[0]


@pytest.fixture(scope="session")
def built_wheel(built_distributions: tuple[Path, Path]) -> Path:
    return built_distributions[0]


def test_python_license_matches_repository_license() -> None:
    repository_license = PYTHON_PROJECT.parents[1] / "LICENSE"
    if not repository_license.is_file():
        pytest.skip("standalone source distribution has no monorepo license")
    assert (PYTHON_PROJECT / "LICENSE").read_bytes() == repository_license.read_bytes()


def test_wheel_and_sdist_contain_the_license(
    built_distributions: tuple[Path, Path],
) -> None:
    wheel, source_distribution = built_distributions
    expected_license = (PYTHON_PROJECT / "LICENSE").read_bytes()

    with zipfile.ZipFile(wheel) as archive:
        wheel_license_names = [
            name
            for name in archive.namelist()
            if name.endswith(".dist-info/licenses/LICENSE")
        ]
        assert len(wheel_license_names) == 1
        assert archive.read(wheel_license_names[0]) == expected_license
        wheel_metadata_names = [
            name for name in archive.namelist() if name.endswith(".dist-info/METADATA")
        ]
        assert len(wheel_metadata_names) == 1
        wheel_metadata = archive.read(wheel_metadata_names[0]).decode("utf-8")
        assert "\nLicense-Expression: MIT\n" in wheel_metadata
        assert "\nLicense-File: LICENSE\n" in wheel_metadata

    with tarfile.open(source_distribution, mode="r:gz") as archive:
        sdist_license_members = [
            member
            for member in archive.getmembers()
            if member.name.endswith("/LICENSE") and member.isfile()
        ]
        assert len(sdist_license_members) == 1
        extracted_license = archive.extractfile(sdist_license_members[0])
        assert extracted_license is not None
        assert extracted_license.read() == expected_license
        assert any(
            member.name.endswith("/lit_shell/py.typed") and member.isfile()
            for member in archive.getmembers()
        )


def test_sdist_contains_the_complete_test_support_tree(
    built_distributions: tuple[Path, Path],
) -> None:
    _, source_distribution = built_distributions
    expected = {
        "tests/README.md",
        "tests/__init__.py",
        "tests/conftest.py",
        "tests/contract_server.py",
    }

    with tarfile.open(source_distribution, mode="r:gz") as archive:
        names = {
            member.name.split("/", 1)[1]
            for member in archive.getmembers()
            if member.isfile() and "/" in member.name
        }

    assert expected <= names


def test_wheel_contains_the_documented_lit_shell_package_only(
    built_wheel: Path,
) -> None:
    with zipfile.ZipFile(built_wheel) as archive:
        names = set(archive.namelist())

    assert "lit_shell/__init__.py" in names
    assert "lit_shell/client.py" in names
    assert "lit_shell/py.typed" in names
    assert "lit_shell/types.py" in names
    assert not any(name.startswith("litshell/") for name in names)
    assert not any(name.startswith("src/") for name in names)


def test_wheel_import_exposes_the_documented_client(
    built_wheel: Path, tmp_path: Path
) -> None:
    script = """
from importlib.metadata import version

import lit_shell
from lit_shell import TerminalClient

assert lit_shell.__version__ == version("lit-shell")
assert TerminalClient.__module__ == "lit_shell.client"
print(lit_shell.__file__)
"""
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(built_wheel)
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=tmp_path,
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert str(built_wheel) in result.stdout


def test_wheel_types_are_visible_to_an_external_mypy_consumer(
    built_wheel: Path, tmp_path: Path
) -> None:
    installation_dir = tmp_path / "site-packages"
    install_result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--no-deps",
            "--no-index",
            "--target",
            str(installation_dir),
            str(built_wheel),
        ],
        cwd=tmp_path,
        text=True,
        capture_output=True,
        check=False,
    )
    assert install_result.returncode == 0, install_result.stdout + install_result.stderr

    consumer = tmp_path / "consumer.py"
    consumer.write_text(
        'from lit_shell import TerminalClient\n\nclient = TerminalClient("ws://localhost")\n',
        encoding="utf-8",
    )
    environment = os.environ.copy()
    environment["MYPYPATH"] = str(installation_dir)
    mypy_result = subprocess.run(
        [sys.executable, "-m", "mypy", "--strict", str(consumer)],
        cwd=tmp_path,
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )

    assert mypy_result.returncode == 0, mypy_result.stdout + mypy_result.stderr
