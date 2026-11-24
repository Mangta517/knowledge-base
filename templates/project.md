---
title: "项目名称"
description: "项目解决的问题和主要技术路径。"
type: project
id: "example-project"
tags: ["firmware"]
created: "2026-11-21"
updated: "2026-11-21"
draft: true
repo: "owner/example-project"
repo_url: "https://github.com/owner/example-project"
visibility: public
publish_policy: public
tier: active
status: active
domains: ["embedded"]
tech_stack: ["C", "CMake", "FreeRTOS"]
primary_language: "C"
stars: 0
synced_commit: "待填写提交 SHA"
featured: false
related_topics: []
related_adrs: []
---

## 项目定位与工程组成

列出主目标、子工程、运行入口和构建工具，注明本文覆盖的实际构建目标。

> [!NOTE]
> 固定提交源码核对事实。引用包含完整 SHA 的 GitHub Blob 链接，写明配置、调用点和单位。

## 硬件资源与外设映射

| 器件或资源 | MCU 实例与引脚 | 配置、占用与依据 |
| --- | --- | --- |
| 待核对 | 待核对 | 交叉核对引脚配置、时钟树及驱动 |

## 架构与执行机制

给出任务、中断和主循环的所有权。记录优先级、栈单位、周期、阻塞上限及交接方式。

## 关键协议、存储布局与算法设计

按实际实现列出帧字段、地址区间、数据单位、状态转移与失败分支。

> [!TIP]
> 历史 README / 调参记录。标明版本及当前实现的对应值。

## 源码入口与核心调用链

从入口沿生产、消费和返回路径列固定提交链接。注明各节点输入、输出及失败走向。

## 构建方式与验证边界

记录构建目标、依赖和产物，标明已有的源码、主机、固件构建与实板证据。

> [!WARNING]
> 需实板/仪器验证边界。给出可观察的信号、样本和判定条件。

## 相关知识

用带显示文本的站内链接连接专题、决策及排障，维护对应的结构化关系。

<!-- HUMAN-NOTES:START -->
## 个人复盘与后续思考
（由人工补充与维护）
<!-- HUMAN-NOTES:END -->
