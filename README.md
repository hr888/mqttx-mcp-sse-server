# 巴法云MQTT MCP服务器

基于魔搭平台的巴法云MQTT智能灯光控制MCP服务器。

## 功能特性

- ✅ MCP协议标准兼容
- ✅ 巴法云MQTT集成
- ✅ 智能灯光控制
- ✅ SSE实时通信
- ✅ 健康检查端点

## 部署到魔搭平台

1. 创建新的MCP服务器项目
2. 上传所有文件
3. 在服务配置中使用正确的JSON结构
4. 启动服务器

## 使用示例
javascript
// 连接巴法云
{
"jsonrpc": "2.0",
"id": 1,
"method": "tools/call",
"params": {
"name": "connectBemfa"
}
}
// 控制灯光
{
"jsonrpc": "2.0",
"id": 2,
"method": "tools/call",
"params": {
"name": "controlLight",
"arguments": {
"command": "on"
}
}
}
## 环境变量

- `BEMFA_SERVER`: 巴法云服务器地址
- `BEMFA_PORT`: 巴法云端口
- `DEFAULT_CLIENT_ID`: 默认客户端ID
- `DEFAULT_TOPIC`: 默认主题名称
- `SERVER_PORT`: 服务器端口
