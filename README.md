# ChatGPT 提示词优化（独立版）

只做一件事：**把输入框里的提示词，通过官方"临时聊天"自动改写得更清晰，然后回填给你确认**。
本地自用、零依赖、后台驱动、无遮罩、完全可见。数据只存本机。

仓库地址：`https://github.com/TTxxtt/chatgpt-optimize`（私有）

## 目录结构

```
chatgpt-optimize/
├── README.md       ← 本文件（使用说明）
├── .gitignore
└── src/            ← 扩展源码（加载这个文件夹）
    ├── manifest.json
    ├── background.js   优化引擎（临时聊天 + scripting 遥控 + SSE 抓取）
    ├── content.js      页面按钮/确认条/取消还原
    ├── content.css
    ├── popup.html/js/css  设置（模式 + 双模板）
    └── icons/
```

## 怎么用（三选一）

### 方式 1：本机直接加载（推荐，最快）

1. Chrome 打开 `chrome://extensions`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序** → 选择本仓库的 `src` 文件夹
4. 打开/刷新 `chatgpt.com` → **输入框下方出现「✨优化」**

### 方式 2：从 GitHub 下载到别的电脑

1. 打开 https://github.com/TTxxtt/chatgpt-optimize
2. 绿色 **Code** 按钮 → **Download ZIP**
3. 解压 → 按方式 1 加载解压出来的 `chatgpt-optimize/src` 文件夹

### 方式 3：克隆到别的电脑（以后要改代码再用）

```bash
git clone https://github.com/TTxxtt/chatgpt-optimize.git
```
（私有仓库首次克隆会要求输入 GitHub 账号密码；建议用 Personal Access Token 作为密码）

## 日常使用

1. 在 ChatGPT 输入框写好内容 → 点「✨优化」（或 **Alt+O**）
2. 自动**前台打开官方临时聊天**（`?temporary-chat=true`，**不留历史**）——你可以实时看到改写过程
3. 对话结束 → 自动**切回原页面**，结果已填入输入框，顶部确认条：
   - **回车 = 确认**（保留改写结果）
   - **Esc = 还原**（恢复你的原文）
4. 运行中：点「⏳优化中…」或按 Esc = 取消（关闭临时聊天 + 还原原文）
5. ChatGPT 正在回复时点优化会提示"请等回复结束后再优化"

弹窗（点工具栏图标）可设置：**Instant/Thinking 模式**、**双模板编辑**（新对话模板 / 对话中模板，`{{prompt}}`+`{{firstUser}}`/`{{lastUser}}`/`{{lastAssistant}}`，各 2000 字符）。

## 更新扩展 / 代码

本地改完代码后提交推送：

```bash
cd src 的上一级目录（仓库根）
git add -A
git commit -m "更新说明"
git push origin main
```

推送需要 GitHub 凭据（Personal Access Token，权限勾 `repo`；用后可在 GitHub 设置里撤销）。

## 权限说明

- `storage`：设置/模板
- `scripting`：遥控临时聊天页（填文本/抓取回答）
- 无 `downloads`、无任何云服务、不上传任何数据

## 常见问题

| 问题 | 处理 |
|---|---|
| 找不到输入框提示 | 确认在对话页；弹窗会把诊断复制到剪贴板，发给我修正选择器 |
| 更新后不生效 | chrome://extensions 里点扩展的刷新 → 重开 ChatGPT 页面 |
| 想恢复出厂 | 弹窗里"恢复默认"模板；清空扩展数据即可 |