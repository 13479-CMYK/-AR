# 学院标志 WebAR 测试

这是一个基于 Vite、Three.js 与 MindAR 的单图像追踪原型。点击按钮后才申请摄像头权限；识别学院入口的三个发光标志后，在图像中心显示缓慢旋转的绿色立方体。

## 本地运行

推荐使用 Node.js 20 LTS；项目也为 MindAR 的旧版 `canvas` 传递依赖设置了兼容覆盖。

```bash
npm install
npm run dev
```

电脑上可通过 `http://localhost:5173` 调试页面。手机摄像头测试必须使用 HTTPS，不能把普通局域网 HTTP 地址当作有效测试环境。

生产构建与预览：

```bash
npm run build
npm run preview
```

## 识别目标文件

- 原始照片：`assets/school-logo.jpg`
- 实际编译图片：`public/targets/school-logo-target.jpg`
- 编译结果：`public/targets/school-logo.mind`

本项目使用 MindAR 1.2.5，并提供可复现的本地编译命令：

```bash
npm run compile:target
```

该命令直接调用 MindAR 包内的官方 `OfflineCompiler`，输入和输出路径均已固定。也可以使用[官方网页编译器](https://hiukim.github.io/mind-ar-js-doc/tools/compile/)观察特征点分布。

重新编译步骤：

1. 替换 `public/targets/school-logo-target.jpg`。
2. 运行 `npm run compile:target`，生成 `public/targets/school-logo.mind`。
3. 如需检查特征点质量，在桌面浏览器打开官方 Image Targets Compiler，上传同一张目标图并点击 **Start**。
4. 运行 `npm run build`，确认 `dist/targets/school-logo.mind` 存在。

每次更换或重新裁切目标图片都必须重新生成 `.mind`。不要仅替换 JPG 而继续使用旧的 `.mind`。

## Vercel 部署

1. 将 `webar-logo-test` 推送到你授权的 GitHub 仓库。
2. 在 Vercel 导入该仓库；Framework Preset 选择 Vite。
3. Build Command 使用 `npm run build`，Output Directory 使用 `dist`。
4. 部署后使用 Vercel 提供的 HTTPS 地址在 iPhone Safari 打开。

## iPhone 现场验证

- 点击“启动 AR”后允许摄像头权限，并确认出现后置摄像头画面。
- 对准真实墙面标志，验证绿色立方体出现、旋转并随视角移动。
- 移开标志，验证丢失提示；重新对准，验证恢复。
- 点击“停止 AR”，确认摄像头指示熄灭；再次启动应仍可使用。
- 在不同距离和光照下记录识别成功率。

屏幕上显示目标照片成功不等于真实发光标志识别成功。最终验收必须到现场测试。

## 已知限制

目标包含重复的圆形内部纹理、发光边缘与反光，可能降低特征匹配稳定性。当前裁切保留了三个不同外轮廓和少量墙面纹理以增加辨识度。如果现场表现不稳，应优先重新拍摄正对、清晰、曝光不过度的完整照片，再重新编译目标。
