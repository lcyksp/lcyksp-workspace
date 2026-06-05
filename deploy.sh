#!/bin/bash

# 确保脚本遇到任何一个错误就立即停止，防止带病上线
set -e

echo "🚀 [1/4] 开始在本地编译前端 Vue3 项目..."
cd ./lcyksp-front
npm run build
cd ..

echo "🧹 [2/4] 正在清理云端服务器的旧 dist 残留..."
ssh admin@47.106.101.81 "rm -rf /home/admin/lcyksp-base/lcyksp-backend/dist"

echo "📦 [3/4] 开始合体打包：强行空投全新前端静态产物到后端目录..."
scp -r ./lcyksp-front/dist admin@47.106.101.81:/home/admin/lcyksp-base/lcyksp-backend/dist

echo "📡 [4/4] 同步更新后端核心路由与配置文件..."
scp ./lcyksp-backend/src/routes/recipe.js admin@47.106.101.81:/home/admin/lcyksp-base/lcyksp-backend/src/routes/recipe.js
scp ./lcyksp-backend/src/config/db.js admin@47.106.101.81:/home/admin/lcyksp-base/lcyksp-backend/src/config/db.js
if [ -f "./lcyksp-backend/src/utils/crypto.js" ]; then
    scp ./lcyksp-backend/src/utils/crypto.js admin@47.106.101.81:/home/admin/lcyksp-base/lcyksp-backend/src/utils/crypto.js
fi

echo "🔥 [🔄] 正在远程连接阿里云，物理清空缓存并重启 Node.js 引擎..."
ssh admin@47.106.101.81 "cd /home/admin/lcyksp-base/lcyksp-backend && pm2 delete all && pm2 start src/app.js --name 'lcyksp-backend'"

echo "🎉 完成！"