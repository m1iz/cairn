# 未签名 Preview 候选包手册

> 文档状态：Active<br>
> 面向读者：发布维护者<br>
> 最后核验：2026-08-29<br>
> 事实源：`scripts/assemble-preview-release-bundle.mjs`、`scripts/preview-*-contract.mjs`、`scripts/publish-preview-release.sh` 与 Preview electron-builder 配置

本手册记录仓库现有脚本支持的 Preview 候选包聚合、验证和发布边界。候选包未签名，不能改名后放入受信发布渠道。

## 标签与平台矩阵

Preview 使用 annotated tag：

```text
v<desktop-version>-preview.<n>
```

聚合输入包含：

- macOS arm64：DMG 与 ZIP；
- macOS x64：DMG 与 ZIP；
- Windows x64：NSIS EXE；
- Linux x64：AppImage 与 DEB；
- 每个平台的 checksum、candidate receipt、packaged smoke receipt 和 `UNSIGNED-PREVIEW` marker；
- Ubuntu 22.04 与 24.04 的 Linux lifecycle receipt。

## 候选包验证

每个平台先运行质量门禁和 packaged smoke。smoke schema 2 必须包含：

- Lifecycle Supervisor 为 `ready`，全部 required service 为 ready；
- 真实 ASAR renderer 的 Node globals absent、Core bridge/bootstrap、attachment 字节、sandbox、context isolation 与 node integration 结果；
- 不含本地绝对路径的 host-OS sandbox backend、status 和 provenance；
- Linux 使用 `--no-sandbox` 测试时明确标记 `disabled-for-linux-test`，其他平台保持 Chromium sandbox enabled。

聚合脚本只接受完整、名称精确的输入集合，并拒绝 Stable 或 `UNSIGNED-INTERNAL` 资产：

```bash
node scripts/assemble-preview-release-bundle.mjs \
  <candidate-input-dir> <bundle-output-dir> \
  <preview-tag> <full-commit-sha> <run-id>
```

输出包含安装资产、平台与生命周期 receipt、两级 SHA-256 清单、合并后的 CycloneDX SBOM、publication manifest，以及从[未签名 Preview 安全说明](unsigned-preview-notice.md)渲染的 Release notes。

## 发布脚本

发布前确保：

- tag commit 与待发布 commit 一致，并且可从默认分支到达；
- GitHub CLI 已登录目标仓库；
- 同名 Release 不存在；
- bundle 通过 `preview-publication-contract.mjs`。

脚本需要 `GITHUB_REF_NAME`、`GITHUB_SHA`、`GITHUB_RUN_ID` 和 `DEFAULT_BRANCH`，并接收聚合目录：

```bash
scripts/publish-preview-release.sh <preview-bundle>
```

脚本先创建 draft Pre-release，上传完整 bundle，逐项比较远端与本地资产清单，全部一致后才公开；中途失败会删除本次创建的 draft，避免留下部分发布。

## 验收与失败处理

- Release 标记为 Pre-release，标题和正文包含 `UNSIGNED-PREVIEW`。
- 七个用户安装资产、receipt、SBOM、checksum、manifest 和安全说明齐全。
- 随机下载每个平台至少一个资产并复核 SHA-256。
- Candidate 或 receipt 缺失时重新生成完整候选，不手工补资产。
- 已公开资产错误时撤下对应 Release，修复后使用新 Preview 序号发布，不原地替换同名二进制。

系统拦截处理只采用单应用确认，不建议用户关闭整机防护。安全边界见[未签名 Preview 安全说明](unsigned-preview-notice.md)。
