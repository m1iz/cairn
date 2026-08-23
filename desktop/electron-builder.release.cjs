function releaseTarget() {
  const target = String(process.env.CAIRN_RELEASE_TARGET || '').trim()
  if (!['mac', 'win', 'linux'].includes(target))
    throw new Error(
      'CAIRN_RELEASE_TARGET must be mac, win or linux for trusted releases',
    )
  return target
}

function requiredWindowsSigningValue(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required for Windows trusted release`)
  return value
}

module.exports = function trustedReleaseConfig() {
  const target = releaseTarget()
  if (target === 'mac') {
    return {
      extends: './electron-builder.yml',
      mac: {
        forceCodeSigning: true,
        hardenedRuntime: true,
        minimumSystemVersion: '14.0',
        notarize: true,
        entitlements: 'build/entitlements.mac.plist',
        entitlementsInherit: 'build/entitlements.mac.inherit.plist',
      },
    }
  }

  if (target === 'linux') {
    return {
      extends: './electron-builder.yml',
      linux: {
        target: ['AppImage', 'deb'],
        artifactName: 'Cairn-Agent-${version}-linux-x64.${ext}',
        maintainer: 'Cairn maintainers',
        vendor: 'Cairn',
      },
    }
  }

  const endpoint = requiredWindowsSigningValue('WINDOWS_SIGNING_ENDPOINT')
  const certificateProfileName = requiredWindowsSigningValue(
    'WINDOWS_SIGNING_PROFILE',
  )
  const codeSigningAccountName = requiredWindowsSigningValue(
    'WINDOWS_SIGNING_ACCOUNT',
  )
  const publisherName = requiredWindowsSigningValue('WINDOWS_SIGNING_PUBLISHER')

  return {
    extends: './electron-builder.yml',
    win: {
      forceCodeSigning: true,
      publisherName: [publisherName],
      azureSignOptions: {
        endpoint,
        certificateProfileName,
        codeSigningAccountName,
      },
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
    },
  }
}
