# Codex Lumo

Codex Lumo 是一个 Windows 桌面悬浮伴侣，用紧凑的灵动窗展示本机 Codex 任务、最近回复、运行状态、额度以及 CPU 和内存占用。

![Codex Lumo](desktop-app/assets/lumo.png)

## 功能

- 自动读取本机 Codex 会话与任务事件，不上传日志。
- 展示所有正在运行的任务、当前动作、最近可见回复、工作区与运行时间。
- 只有收到可见回复时才自动弹出，思考摘要和工具过程保持静默。
- 支持贴顶自动隐藏、全窗口拖动、双击打开 Codex 和托盘设置。
- 内置多状态宠物动画，并在隐藏时降低刷新和采样频率。
- 提供安装版与免安装便携版。

## 下载

从 [GitHub Releases](https://github.com/weihang-luo/codex-lumo/releases/latest) 下载最新版本：

- `Codex-Lumo-Setup-*-x64.exe`：Windows 安装版。
- `Codex-Lumo-Portable-*-x64.exe`：免安装便携版。

## 本地开发

需要 Node.js 22 或更高版本。

```powershell
cd desktop-app
npm install
npm test
npm start
```

构建 Windows 安装包：

```powershell
npm run dist
```

生成文件位于 `desktop-app/release/`。

## 隐私

桌面应用只读访问 `%USERPROFILE%\.codex\sessions` 和本机 Codex 日志数据库。任务解析、系统状态采样和界面渲染均在本机完成。

## 许可证

项目采用 [MIT License](LICENSE)。宠物形象改编自 MIT 许可的 React Kawaii `Cyborg`，第三方许可与来源见 `desktop-app/assets/pet/`。
