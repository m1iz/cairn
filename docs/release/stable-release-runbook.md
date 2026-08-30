# 受信候选包手册

> 文档状态：Active<br>
> 面向读者：发布维护者<br>
> 最后核验：2026-08-29<br>
> 事实源：`scripts/build_desktop_release.sh`、`scripts/verify-*-release.*`、`scripts/assemble-release-bundle.mjs`、`scripts/publish-release.sh`

本手册记录仓库现有的受信候选包构建、验证、聚合与发布脚本。受信 bundle 只接受签名状态、平台 receipt 和文件清单均通过 contract 的资产；`UNSIGNED-INTERNAL` 与 `UNSIGNED-PREVIEW` 资产会被拒绝。

## 平台要求

- macOS arm64 / x64：Developer ID 签名、notarization、DMG/ZIP 与 packaged smoke；
- Windows x64：Authenticode 签名、NSIS 安装包、安装/卸载与 packaged smoke；
- Linux x64：AppImage/DEB，以及 Ubuntu 22.04 / 24.04 安装、smoke 和移除 receipt。

各平台 verification script 必须确认签名身份、安装资产、checksum 和 smoke receipt。Windows 包必须包含原生 sandbox helper，且 packaged smoke 只有在 helper 的负向隔离自检通过并报告 `windows-native · available` 时才可生成候选包。

## 凭证边界

macOS 构建使用：

- `MACOS_CERTIFICATE`
- `MACOS_CERTIFICATE_PASSWORD`
- `APPLE_API_KEY_BASE64`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `APPLE_TEAM_ID`

Windows 构建使用：

- `WINDOWS_SIGNING_ENDPOINT`
- `WINDOWS_SIGNING_PROFILE`
- `WINDOWS_SIGNING_ACCOUNT`
- `WINDOWS_SIGNING_PUBLISHER`
- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`

凭证只进入受控构建环境，不写入仓库、receipt、日志、SBOM 或安装资产。

## 聚合验证

tag 必须与 `desktop/package.json` 的版本完全一致：

```text
v<major>.<minor>.<patch>
```

将平台资产和 receipt 放入同一输入目录后运行：

```bash
node scripts/assemble-release-bundle.mjs \
  <candidate-input-dir> <bundle-output-dir> \
  <stable-tag> <full-commit-sha>
```

聚合器要求完整的平台矩阵、每组 checksum、packaged smoke schema 2 和 Linux lifecycle receipt。它拒绝目录、符号链接、额外资产、签名状态不一致、commit 不匹配及 checksum 覆盖不完整，并生成 release manifest、全 bundle `SHA256SUMS.txt` 和合并 SBOM。

## 发布脚本

发布前应确保 GitHub CLI 已登录目标仓库、tag 已存在、同名 Release 不存在，并再次验证 bundle checksum。设置 `CAIRN_RELEASE_TAG` 或 `GITHUB_REF_NAME` 后运行：

```bash
scripts/publish-release.sh <release-bundle>
```

脚本先创建 draft，上传 bundle，比较远端和本地资产清单，完全一致后才公开。中途失败会删除本次创建的 draft。

## 最终验收

- 两个 macOS 架构均显示预期 Developer ID，notarization ticket 可验证。
- Windows EXE publisher 与签名策略完全一致。
- Linux 两个 Ubuntu 版本的安装、smoke、移除 receipt 齐全。
- 所有资产通过 `SHA256SUMS.txt`，SBOM 与发布 commit、lockfile 和资产 inventory 一致。
- 从全新用户环境完成安装、模型配置、Chat 与 Build smoke。
- 发现错误时撤下 Release 并发布新版本，不原地替换同名二进制。
