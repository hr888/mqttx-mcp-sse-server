# 巴法云MQTT MCP服务器（安全版本）

基于魔搭平台的巴法云MQTT智能灯光控制服务。**此版本不包含任何预设配置，用户必须提供自己的巴法云参数。**

## ⚠️ 安全说明

此MCP服务是**完全安全的公开版本**，不包含：
- ❌ 预设的巴法云客户端ID
- ❌ 预设的MQTT主题
- ❌ 任何个人认证信息

## 使用步骤

### 第一步：配置巴法云参数
javascript
{
"jsonrpc": "2.0",
"id": 1,
"method": "tools/call",
"params": {
"name": "configureBemfa",
"arguments": {
"clientId": "您的巴法云客户端ID",
"topic": "您的设备主题",
"host": "bemfa.com", // 可选，默认bemfa.com
"port": 9501, // 可选，默认9501
"username": "", // 可选
"password": "" // 可选
}
}
}
### 第二步：连接MQTT服务器
javascript
{
"jsonrpc": "2.0",
"id": 2,
"method": "tools/call",
"params": {
"name": "connectBemfa"
}
}
### 第三步：控制设备
javascript
{
"jsonrpc": "2.0",
"id": 3,
"method": "tools/call",
"params": {
"name": "controlLight",
"arguments": {
"command": "on" // on, off, toggle, status
}
}
}
## 如何获取巴法云参数

1. 访问 [巴法云官网](https://www.bemfa.com/)
2. 注册账号并登录控制台
3. 创建MQTT设备，获取客户端ID和主题
4. 将参数填入configureBemfa工具

## 功能特性

- ✅ 完全匿名，不包含预设配置
- ✅ 会话隔离，每个用户独立配置
- ✅ 敏感信息日志过滤
- ✅ MCP协议标准兼容
- ✅ 实时状态通知

## 部署说明

此服务可安全部署到任何公共平台，不会泄露任何个人信息。
