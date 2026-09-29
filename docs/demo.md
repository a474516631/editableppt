# Demo：两张图片生成一份可编辑 PPT

本示例演示用户从 ChatGPT 或 Nano Banana 保存两张幻灯片图片后，如何在 Codex 中得到一份 PPTX。示例路径和结果用于说明操作；实际图层质量取决于输入图片及 EditablePPT 服务的拆分结果。

## 准备图片

将图片保存为：

```text
/Users/me/slides/01-cover.png
/Users/me/slides/02-chart.jpg
```

建议使用清晰、完整、未裁切的幻灯片图片。每张图片不超过 8 MB、2500 万像素；当前支持 PNG 和 JPG。

## 在 Codex 中运行

安装插件并开启新任务后，输入：

```text
$editableppt-image-to-ppt:image-to-ppt
请把 /Users/me/slides/01-cover.png 和 /Users/me/slides/02-chart.jpg
按这个顺序转换为一份可编辑 PPT，标题为“季度业务回顾”。
```

首次使用会进入授权流程：在 [API Keys 页面](https://editableppt.com/settings/apikeys) 创建密钥，并按 skill 提示在终端中输入。授权完成后，skill 会重新发起转换。之后使用通常只需给图片和标题。

## 查看结果

MCP 先返回一个 `job_id`；skill 会用它查询任务，直到状态为 `success` 或 `failed`。成功时的结果格式示例：

```json
{
  "status": "success",
  "completed": 2,
  "total": 2,
  "output_path": "/Users/me/slides/季度业务回顾.pptx",
  "slide_count": 2,
  "bytes": 123456
}
```

此处的字节数仅示意。打开生成的 `.pptx`，可分别选择和编辑识别出的文本、形状和图片对象。若某些元素未正确拆分，可在 PowerPoint 中调整；不要把示例输出当作像素级还原保证。

## 常见问题

| 提示                      | 处理方式                                                  |
| ------------------------- | --------------------------------------------------------- |
| `Authorization required`  | 在 API Keys 页面创建密钥，并按 skill 提示完成终端授权。   |
| `Use PNG or JPG` / `8 MB` | 转换为支持格式并缩小文件。                                |
| `429` 或账户忙碌          | 工具会自动等待限流窗口；持续失败时稍后重试。              |
| `Unknown conversion job`  | MCP 进程可能已重启；重新运行 skill 发起任务。             |
| 生产接口返回 404/503      | 确认 EditablePPT 服务端已部署相关接口并配置图片转换服务。 |

开发者无需真实账号即可运行 `node --test tests/editableppt-mcp.test.mjs` 验证 MCP 协议和多图合并调用流程；此测试使用模拟 PPTX 字节，不代表真实图层拆分的演示结果。
