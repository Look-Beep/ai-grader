#!/usr/bin/env bash
# 智慧判启动脚本（Linux / macOS）
# 默认允许局域网内其他电脑/手机访问（在终端里会打印出访问地址）
# 用法：./start.sh         局域网模式
#       ./start.sh local   仅本机访问
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] 未检测到 Node.js，请先安装 Node.js 18 或更高版本：https://nodejs.org/"
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "[ERROR] 当前 Node.js 版本为 $(node -v)，请升级到 18 或更高版本。"
  exit 1
fi

if [ "$1" = "local" ]; then
  export HOST=127.0.0.1
  echo "[info] 仅本机访问模式"
fi

exec node server.js
