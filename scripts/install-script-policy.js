export function analyzeInstallScriptPolicy(manifest, lockfile) {
  if (
    manifest.allowScripts === null ||
    typeof manifest.allowScripts !== 'object' ||
    Array.isArray(manifest.allowScripts)
  ) {
    throw new TypeError('package.json allowScripts must be an object');
  }

  const installScriptPackages = new Set();
  for (const [packagePath, packageMetadata] of Object.entries(
    lockfile.packages ?? {},
  )) {
    if (packageMetadata.hasInstallScript !== true) continue;
    if (packagePath === '') {
      throw new Error(
        'Root package install-time lifecycle scripts are prohibited',
      );
    }

    const marker = 'node_modules/';
    const markerIndex = packagePath.lastIndexOf(marker);
    if (markerIndex === -1 || typeof packageMetadata.version !== 'string') {
      throw new Error(
        `Cannot identify install-script dependency at ${packagePath}`,
      );
    }
    const packageName = packagePath.slice(markerIndex + marker.length);
    installScriptPackages.add(`${packageName}@${packageMetadata.version}`);
  }

  const policyEntries = Object.entries(manifest.allowScripts);
  for (const [policyKey, decision] of policyEntries) {
    if (typeof decision !== 'boolean') {
      throw new TypeError(
        `allowScripts decision for ${policyKey} must be boolean`,
      );
    }
  }

  const stalePolicyEntries = policyEntries
    .filter(([policyKey, decision]) =>
      decision
        ? !installScriptPackages.has(policyKey)
        : ![...installScriptPackages].some((packageIdentity) =>
            matchesPolicyKey(packageIdentity, policyKey),
          ),
    )
    .map(([policyKey]) => policyKey)
    .sort();
  const uncoveredLockEntries = [...installScriptPackages]
    .filter(
      (packageIdentity) =>
        !policyEntries.some(([policyKey]) =>
          matchesPolicyKey(packageIdentity, policyKey),
        ),
    )
    .sort();

  return {
    installScriptPackages: [...installScriptPackages].sort(),
    stalePolicyEntries,
    uncoveredLockEntries,
  };
}

function matchesPolicyKey(packageIdentity, policyKey) {
  return (
    packageIdentity === policyKey || packageIdentity.startsWith(`${policyKey}@`)
  );
}
