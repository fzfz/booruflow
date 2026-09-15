# CI/CD 门禁

## 合并代码

贡献者通过 PR 将修改合入 `main`。GitHub 的 `main CI gate` 规则要求分支与最新主线同步、所有审阅讨论已解决，并且由 GitHub Actions 提交的 `CI Gate` 检查成功。该检查汇总 Windows、macOS Apple Silicon、macOS Intel 的测试和三平台数据互导结果；任一依赖任务失败、取消或跳过，门禁都会失败。

当前规则要求 0 个他人批准，单人维护者可以合并自己的 PR。维护者仍按 [PR 规范](../community/pull-requests.md)检查改动。规则适用于管理员，并要求线性历史；维护者使用 squash 或 rebase 合并，保留主分支并通过新提交修正错误。

## 发布版本

维护者先按[发布流程](releases.md)准备版本，将改动通过 PR 合入主线，再创建版本标签。`Release checks` 会验证标签格式、标签提交属于 `main`、包版本与安装器默认标签及数据包应用版本一致，并要求存在 `docs/releases/vX.Y.Z.md`。维护者按[发布流程](releases.md)中的发行说明要求编写该文件；发布脚本将完整文件作为说明提交给 GitHub。

`Release Gate` 要求发布前检查、三平台测试、真实标签安装测试和数据互导全部成功。之后发布任务进入 `github-release` 环境，等待 `fzfz` 在 GitHub Actions 中确认标签、提交和检查结果并批准。批准后，任务先建立草稿、上传 `install.bat` 和 `install.sh`，再将草稿发布。普通分支的手动运行只执行检查。

已有公开 Release 保持原样。若上传失败后留下草稿，维护者检查该草稿并删除本次未完成的草稿后重跑失败任务；脚本会拒绝覆盖现有 Release。`immutable release tags` 规则保留所有 `v*` 标签的目标和名称，修复版本使用新标签。环境审批约束 Actions 发布任务；拥有仓库管理权限的人仍能修改仓库设置或手动操作 Release。

## 查看失败

PR 页面显示 `CI Gate`；Actions 的 `Platform checks` 提供各平台详细结果。发布失败时查看 `Release checks` 的失败步骤，修复对应问题后重新运行检查。测试范围和覆盖率验收要求见[测试](testing.md)。
