---
description: 切换 profile（/profile <名字>；空参列出全部）
---
用户指令：切换 grit profile。调用 `profile` 工具处理：
- 本命令带参数时：action="switch"，name="$ARGUMENTS"。
- 无参数时：action="list"，把可用 profile 列给用户。
工具返回后，把结果和生效边界（哪些立即生效、哪些自动热生效，以及"当前会话模型不追溯"）简明复述给用户。不要做其他事。
