# 表情宇宙：技术路线与交互说明

本项目为“单页静态站点”：`index.html` + `app.js` 即应用本体。

核心链路：

1. 用户点击“开始体验”（满足 iOS/微信对摄像头的用户手势要求）
2. `getUserMedia` 获取摄像头视频帧（不使用 MediaPipe `camera_utils`，避免二次授权/流冲突）
3. MediaPipe FaceMesh 从 `<video>` 帧提取人脸关键点
4. 将人脸动作/表情映射为粒子系统的缩放、风场、聚散、颜色与爆发
5. Three.js 粒子系统持续渲染（按性能档位节流）

---

## 1. 技术栈

- 渲染：Three.js（CDN），`THREE.Points + BufferGeometry + PointsMaterial`
- 人脸追踪：MediaPipe FaceMesh（CDN），单人脸、轻量配置
- 运行形态：纯静态文件，适合 Vercel 静态部署；摄像头需要 HTTPS

---

## 2. 人脸追踪数据（FaceMesh → 交互参数）

在 `app.js` 的 `onFaceResults()` 中，从 FaceMesh 关键点推导：

- `faceX/faceY`：鼻尖（landmark 1）相对画面中心的偏移（-1..1）
- `faceScale`：双眼外侧距离（33↔263）与“校准基准”的比值（近大远小）
- `yaw/pitch`：鼻尖相对眼中心的偏移，按眼距归一化后映射（-1..1）
- `smile`：嘴角宽度（61↔291）+ 嘴角相对眼中心的抬升
- `mouthOpen`：上下唇距离（13↔14）按脸尺度归一化
- `blink`（可选）：眼睑开合（159↔145、386↔374）相对校准值的反比
- `frown`（可选）：眉毛到上眼睑距离（105↔159、334↔386）相对校准值的反比

以上参数会进入 `faceTarget`，并在 `updateTrackingSmooth()` 做 lerp 平滑以减少抖动。

---

## 3. 粒子世界（Three.js）

- `basePositions`：粒子“初始形态”的基准点（本项目为 **笑脸点云**）
- `position`：实际渲染位置（带速度、风场、聚散力）
- `velocities`：每个粒子的速度，用于惯性与爆发效果
- `colors`：逐点颜色（`vertexColors + AdditiveBlending`）
- `roles`：粒子分组（脸轮廓/左眼/右眼/嘴），用于做局部表情形变

交互映射（核心思路）：

- 左右转头（`yaw`）：改变风向与整体旋转（更像“宇宙风场”）
- 上下抬头（`pitch`）：改变“重力方向/流向”
- 靠近（`faceScale` 变大）：更聚拢、更清晰
- 远离（`faceScale` 变小）：更发散、更朦胧
- 微笑（`smile`）：嘴部弧度增强 + 偏暖色
- 张嘴（`mouthOpen`）：嘴部从“弧线笑”过渡到“张嘴椭圆” + 能量提升
- 闭眼（`blink`）：眼睛从“圆形”过渡到“闭眼线”
- 皱眉（`frown`）：聚合增强、颜色偏冷、对比更强（可选）
- 连续摇头：触发颜色循环变化（Hue cycle）

---

## 4. 交互模式

`modeSelect` 提供 3 种模式（在 `MODE_PRESETS` 定义）：

- `Resonance`：平衡（默认）
- `Burst`：强调“张嘴/大笑”的爆发触发
- `Drift`：更强的自动漂移与展示感

---

## 5. 性能自适应与兼容策略（重点：iPad Pro 1 代 / 微信内置浏览器）

### 5.1 档位选择

`resolveInitialTier()` 自动选择：

- `prefers-reduced-motion` → `low`
- 微信内置浏览器 → `low`
- iPad Pro 1 代（粗略判定）→ `low`
- 其他 iOS → `medium`
- 其余默认 → `high`

也支持 URL 强制：`?quality=high|medium|low`。

### 5.2 档位影响面

档位会同时调整：

- 粒子数、DPR 上限、抗锯齿、雾效、深度测试
- 渲染节流：`renderIntervalMs`
- 粒子更新节流：`particleUpdateIntervalMs`
- 追踪喂帧节流：`faceFrameIntervalMs`
- 摄像头分辨率（低档降低带宽与耗电）

### 5.3 微信内置浏览器

- 更容易遇到权限/全屏限制：全屏按钮会提示“建议在浏览器打开”
- 仍遵循“用户手势后再请求摄像头”的启动流程

---

## 6. 文件入口

- `index.html`：页面结构、UI、CDN 依赖
- `app.js`：全部逻辑（质量档位/人脸追踪/粒子系统/交互映射）
- `vercel.json`：静态部署安全头、禁用强缓存、重写路由

---

## 7. UI 可调项

- 粒子颜色：面板中的颜色选择器（基础色）
- 连续摇头：在基础色之上做 Hue 循环偏移
