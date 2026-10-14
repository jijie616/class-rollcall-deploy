#!/usr/bin/env bash
# 初始提交脚本：把已完成的代码按逻辑单元拆成一系列提交。
#
# 用法（在仓库根目录执行）：
#     bash tools/init-commits.sh "李文龙" "你的Educoder邮箱"
#
# 为什么要拆成多个提交而不是一次 git add . && git commit：
#   博客 3.7 要求贴出 commit 记录。一个"初始化"提交包含 32 个文件，
#   记录里看不出任何工作量；拆成按模块的提交后，记录本身就能说明做了什么。
#
# 作者身份必须是你本人：仓库级设置，只影响本仓库，不动全局配置。
# 杨泓的提交要由他用他自己的账号做，这样 git log 里的作者才是两个人。

set -euo pipefail

NAME="${1:-}"
EMAIL="${2:-}"

if [ -z "$NAME" ] || [ -z "$EMAIL" ]; then
  echo "用法：bash tools/init-commits.sh \"姓名\" \"邮箱\""
  echo "示例：bash tools/init-commits.sh \"李文龙\" \"you@example.com\""
  exit 1
fi

# —— 安全校验：必须是脚本所在仓库的根目录，且该仓库在它自己身上有 .git ——
# 为什么必须有这两道校验：git 会向上层目录找 .git。如果当前目录不是仓库根，
# 而某个上层目录（例如用户主目录 C:/Users/<name>）恰好是个 git 仓库，
# 后面的 git add / commit 会直接写进**那个不相干的仓库**，并覆盖它的本地身份配置。
cd "$(dirname "$0")/.."
# 统一取 Windows 风格路径，否则 pwd 的 /d/... 与 git 的 D:/... 无法比较
SELF="$(pwd -W 2>/dev/null || pwd)"

if [ ! -d ".git" ]; then
  echo "错误：$SELF 下没有 .git，这不是一个 git 仓库根目录。"
  echo "请先在仓库根目录执行 git init，再运行本脚本。"
  exit 1
fi

TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ "$(echo "$TOPLEVEL" | tr '[:upper:]' '[:lower:]')" != "$(echo "$SELF" | tr '[:upper:]' '[:lower:]')" ]; then
  echo "错误：git 解析出的仓库根是 —— $TOPLEVEL"
  echo "      但脚本所在目录是   —— $SELF"
  echo "两者不一致，说明 git 会向上层目录操作到别的仓库。已中止。"
  exit 1
fi

if git rev-parse --verify HEAD >/dev/null 2>&1; then
  echo "本仓库已有提交，脚本中止（避免重复提交）。"
  echo "请保留现有 .git 与历史，按常规流程增量提交；不要删除仓库元数据。"
  exit 1
fi

git config user.name "$NAME"
git config user.email "$EMAIL"
echo "仓库根：$SELF"
echo "已设置本仓库作者：$NAME <$EMAIL>"
echo ""

commit() {
  local msg="$1"
  shift
  git add -- "$@"
  if git diff --cached --quiet; then
    echo "  ⚠ 跳过（无变更）：$msg"
    return 0
  fi
  git commit -q -m "$msg"
  echo "  ✓ $msg"
}

echo "开始按模块创建提交……"

commit "chore(infra): 初始化工程结构与编码规范" \
  .gitignore .prettierrc package.json

commit "docs: 补充仓库说明、分工报告与博客模板参考" \
  README.md docs/分工报告.md docs/博客模板_原始参考.md

commit "chore(deps): 引入 SheetJS 与 Chart.js 本地副本，不使用 CDN" \
  lib/xlsx.full.min.js lib/chart.umd.js

commit "feat(db): 设计学生、点名记录、积分流水三张表，兼容 MySQL 5.5~8.0" \
  sql/schema.sql

commit "feat(lottery): 实现按积分反比的加权随机抽签与顺序点名" \
  server/lottery.js

commit "test(lottery): 覆盖负积分除零回归、复演一致性与顺序点名推进" \
  tests/test-lottery.js

commit "feat(scorer): 实现积分结算规则，按半分整数运算规避浮点尾差" \
  server/scorer.js

commit "test(scorer): 覆盖计分分支、0.5 步长精度与入参类型陷阱" \
  tests/test-scorer.js

commit "feat(infra): 统一错误码与响应信封，对齐接口约定 3.4.5" \
  server/errors.js

commit "feat(db): 实现内存存储层，接口与 MySQL 实现保持一致" \
  server/store-memory.js

commit "feat(db): 实现 MySQL 存储层，用条件更新保证结算幂等" \
  server/store-mysql.js

commit "feat(api): 实现 HTTP 中间层与接口约定 3.4.4 的 11 个端点" \
  server/api.js server/index.js server/start-mysql.js .env.example

commit "test(api): 覆盖 11 个端点、错误码与接线回归" \
  tests/test-api.js

commit "feat(importer): 实现 Excel 名单解析、行校验与学号类型告警" \
  src/package.json src/js/importer.js

commit "test(importer): 覆盖表头识别、行校验与数字型学号前导零风险" \
  tests/test-importer.js

commit "feat(frontend): 实现前端 HTTP 客户端，统一处理接口基址与错误信封" \
  src/js/api.js

commit "feat(app): 实现主控状态机，按 3.4.2 契约与界面层对接" \
  src/js/app.js

commit "test(app): 用桩件界面驱动主控，连真实服务验证交互链路" \
  tests/test-app.js

commit "chore(dev): 增加临时调试界面，便于在浏览器中验证与交接参照" \
  src/dev.html src/js/ui.debug.js src/js/dev-main.js

commit "test: 增加测试总入口与端到端冒烟脚本" \
  tests/run-all.js tests/smoke-e2e.js

commit "test: 覆盖启动、事务回滚和并发结算回归" \
  tests/test-regressions.js tests/fixtures/mysql-startup-stub.cjs

commit "chore(tools): 增加初始提交脚本与提交计划说明" \
  tools/init-commits.sh docs/git提交流程与提交计划.md

echo ""
echo "完成。共 $(git rev-list --count HEAD) 个提交。"
echo ""
git --no-pager log --oneline
