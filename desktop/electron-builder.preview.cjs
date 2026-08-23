module.exports = {
  extends: './electron-builder.yml',
  mac: {
    target: ['dmg', 'zip'],
    identity: null,
    artifactName:
      'Cairn-Agent-${version}-UNSIGNED-PREVIEW-macos-${arch}.${ext}',
  },
  win: {
    target: ['nsis'],
    artifactName:
      'Cairn-Agent-${version}-UNSIGNED-PREVIEW-windows-${arch}.${ext}',
  },
  linux: {
    target: ['AppImage', 'deb'],
    artifactName: 'Cairn-Agent-${version}-UNSIGNED-PREVIEW-linux-x64.${ext}',
    maintainer: 'Cairn maintainers',
    vendor: 'Cairn',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },
}
