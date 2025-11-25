const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const mqtt = require("mqtt");

// 配置从环境变量读取（不再包含个人敏感信息）
const config = {
  serverPort: parseInt(process.env.SERVER_PORT) || 4000
};

console.log("=== Bemfa MCP Server Starting ===");
console.log("Config:", {
  serverPort: config.serverPort
});

// 简化的Logger
class Logger {
  static info(context, message, data = null) {
    const timestamp = new Date().toISOString();
    let logMessage = `[INFO] [${timestamp}] [${context}] ${message}`;
    if (data) {
      // 过滤敏感信息
      const safeData = { ...data };
      if (safeData.clientId) safeData.clientId = "***" + safeData.clientId.slice(-4);
      if (safeData.password) safeData.password = "***";
      logMessage += ` ${JSON.stringify(safeData)}`;
    }
    console.log(logMessage);
  }
  
  static error(context, message, error = null) {
    const timestamp = new Date().toISOString();
    let logMessage = `[ERROR] [${timestamp}] [${context}] ${message}`;
    if (error) {
      logMessage += ` ${error.message || error}`;
    }
    console.error(logMessage);
  }
}

// Initialize Express app
const app = express();
const port = config.serverPort;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Session management
const SessionManager = {
  sessions: new Map(),
  
  create(res) {
    const sessionId = uuidv4();
    this.sessions.set(sessionId, { 
      sseRes: res, 
      mqttClient: null,
      connected: false,
      config: null // 每个会话独立的配置
    });
    Logger.info("SessionManager", `New session created`, { sessionId });
    return sessionId;
  },
  
  get(sessionId) {
    return this.sessions.get(sessionId);
  },
  
  remove(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session && session.mqttClient) {
      session.mqttClient.end();
    }
    this.sessions.delete(sessionId);
    Logger.info("SessionManager", `Session closed`, { sessionId });
  }
};

// MQTT Handler
const MQTTHandler = {
  async configure(session, args) {
    const sessionId = [...SessionManager.sessions].find(([id, s]) => s === session)?.[0];
    
    // 验证必需的配置参数
    const required = ['clientId', 'topic'];
    const missing = required.filter(field => !args[field]);
    
    if (missing.length > 0) {
      throw new Error(`缺少必需的配置参数: ${missing.join(', ')}`);
    }
    
    // 保存会话配置
    session.config = {
      host: args.host || "bemfa.com",
      port: args.port || 9501,
      clientId: args.clientId,
      topic: args.topic,
      username: args.username || "",
      password: args.password || ""
    };
    
    Logger.info("MQTT", `Configuration saved`, { 
      sessionId,
      host: session.config.host,
      port: session.config.port,
      topic: session.config.topic,
      clientId: "***" + args.clientId.slice(-4) // 日志中隐藏敏感信息
    });
    
    return {
      type: "text",
      text: `✅ 配置已保存，请调用 connectBemfa 进行连接`
    };
  },
  
  async connect(session) {
    const sessionId = [...SessionManager.sessions].find(([id, s]) => s === session)?.[0];
    
    if (!session.config) {
      throw new Error("❌ 请先调用 configureBemfa 配置连接参数");
    }
    
    const config = session.config;
    
    Logger.info("MQTT", `Connecting to Bemfa cloud`, { 
      sessionId,
      host: config.host,
      port: config.port,
      topic: config.topic
    });
    
    // 断开之前的连接
    if (session.mqttClient) {
      session.mqttClient.end();
    }
    
    const options = {
      clientId: config.clientId,
      clean: true
    };
    
    // 添加认证信息（如果提供）
    if (config.username) {
      options.username = config.username;
    }
    if (config.password) {
      options.password = config.password;
    }
    
    const url = `mqtt://${config.host}:${config.port}`;
    
    try {
      const client = mqtt.connect(url, options);
      
      return new Promise((resolve, reject) => {
        client.once('connect', () => {
          Logger.info("MQTT", `Connected to Bemfa cloud`, { sessionId });
          session.mqttClient = client;
          session.connected = true;
          
          // 订阅主题
          client.subscribe(config.topic, (err) => {
            if (err) {
              Logger.error("MQTT", `Subscribe error`, { error: err.message });
            } else {
              Logger.info("MQTT", `Subscribed to topic`, { topic: config.topic });
            }
          });
          
          // 处理接收到的消息
          client.on('message', (topic, message) => {
            const payload = message.toString();
            Logger.info("MQTT", `Received message`, { topic, payload });
            
            this.sendMessageEvent(session.sseRes, {
              method: "notifications/message",
              params: {
                topic: topic,
                payload: payload,
                timestamp: new Date().toISOString()
              }
            });
          });
          
          resolve({
            type: "text",
            text: `✅ 成功连接到巴法云MQTT服务器，主题: ${config.topic}`
          });
        });
        
        client.once('error', (err) => {
          Logger.error("MQTT", `Connection error`, { error: err.message });
          reject(err);
        });
      });
    } catch (error) {
      Logger.error("MQTT", `Connection failed`, { error: error.message });
      throw error;
    }
  },
  
  async controlLight(session, args) {
    if (!session.connected || !session.mqttClient) {
      throw new Error("❌ 未连接到MQTT服务器，请先调用connectBemfa");
    }
    
    if (!session.config) {
      throw new Error("❌ 配置信息丢失，请重新配置");
    }
    
    const command = args.command; // on, off, toggle, status
    const topic = session.config.topic;
    
    // 命令映射
    const commandMap = {
      'on': 'on',
      'off': 'off', 
      'toggle': 'toggle',
      'status': 'status'
    };
    
    const mqttCommand = commandMap[command];
    if (!mqttCommand) {
      throw new Error(`❌ 不支持的命令: ${command}`);
    }
    
    Logger.info("MQTT", `Sending light control command`, { topic, command: mqttCommand });
    
    return new Promise((resolve, reject) => {
      session.mqttClient.publish(topic, mqttCommand, (err) => {
        if (err) {
          Logger.error("MQTT", `Publish error`, { error: err.message });
          reject(err);
        } else {
          const actionText = {
            'on': '开灯',
            'off': '关灯', 
            'toggle': '切换灯光',
            'status': '查询状态'
          }[command];
          
          resolve({
            type: "text",
            text: `✅ 已发送${actionText}命令到设备`
          });
        }
      });
    });
  },
  
  async disconnect(session) {
    if (!session.connected || !session.mqttClient) {
      throw new Error("❌ 未连接");
    }
    
    return new Promise((resolve, reject) => {
      session.mqttClient.end(false, {}, (err) => {
        if (err) {
          reject(err);
        } else {
          session.connected = false;
          session.mqttClient = null;
          // 保留配置信息，便于重新连接
          resolve({
            type: "text",
            text: "✅ 已断开MQTT连接"
          });
        }
      });
    });
  },
  
  async getConfig(session) {
    if (!session.config) {
      return {
        type: "text",
        text: "❌ 尚未配置巴法云参数"
      };
    }
    
    // 返回配置信息（隐藏敏感信息）
    const safeConfig = {
      ...session.config,
      clientId: "***" + session.config.clientId.slice(-4),
      password: session.config.password ? "***" : "未设置"
    };
    
    return {
      type: "text",
      text: `当前配置:\n服务器: ${safeConfig.host}:${safeConfig.port}\n主题: ${safeConfig.topic}\n客户端ID: ${safeConfig.clientId}\n用户名: ${safeConfig.username || "未设置"}\n密码: ${safeConfig.password}`
    };
  },
  
  sendMessageEvent(sseRes, message) {
    if (!sseRes) return;
    
    const jsonMessage = JSON.stringify(message);
    sseRes.write(`event: message\n`);
    sseRes.write(`data: ${jsonMessage}\n\n`);
  }
};

// Response Handler
const ResponseHandler = {
  sendError(sseRes, id, code, message) {
    const errorRes = {
      jsonrpc: "2.0",
      id: id,
      error: { code, message }
    };
    MQTTHandler.sendMessageEvent(sseRes, errorRes);
  },
  
  sendResult(sseRes, id, result) {
    const successRes = {
      jsonrpc: "2.0",
      id: id,
      result
    };
    MQTTHandler.sendMessageEvent(sseRes, successRes);
  },
  
  sendCapabilities(sseRes, id) {
    const capabilities = {
      jsonrpc: "2.0",
      id: id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: { listChanged: true }
        },
        serverInfo: {
          name: "bemfa-mcp",
          version: "1.0.0",
          description: "巴法云MQTT智能灯光控制服务 - 需用户自行配置参数"
        }
      }
    };
    MQTTHandler.sendMessageEvent(sseRes, capabilities);
  },
  
  sendToolsList(sseRes, id) {
    const toolsList = {
      jsonrpc: "2.0",
      id: id,
      result: {
        tools: [
          {
            name: "configureBemfa",
            description: "配置巴法云连接参数（必需第一步）",
            inputSchema: {
              type: "object",
              properties: {
                host: { 
                  type: "string", 
                  description: "MQTT服务器地址，默认: bemfa.com",
                  default: "bemfa.com"
                },
                port: { 
                  type: "number", 
                  description: "MQTT端口，默认: 9501",
                  default: 9501
                },
                clientId: { 
                  type: "string", 
                  description: "巴法云客户端ID（必需）" 
                },
                topic: { 
                  type: "string", 
                  description: "MQTT主题名称（必需）" 
                },
                username: { 
                  type: "string", 
                  description: "用户名（可选）" 
                },
                password: { 
                  type: "string", 
                  description: "密码（可选）" 
                }
              },
              required: ["clientId", "topic"]
            }
          },
          {
            name: "connectBemfa",
            description: "连接到巴法云MQTT服务器",
            inputSchema: {
              type: "object",
              properties: {}
            }
          },
          {
            name: "controlLight",
            description: "控制智能灯光",
            inputSchema: {
              type: "object",
              properties: {
                command: { 
                  type: "string", 
                  enum: ["on", "off", "toggle", "status"],
                  description: "控制命令: 开灯(on), 关灯(off), 切换(toggle), 状态查询(status)" 
                }
              },
              required: ["command"]
            }
          },
          {
            name: "disconnectBemfa",
            description: "断开MQTT连接",
            inputSchema: {
              type: "object",
              properties: {}
            }
          },
          {
            name: "getConfig",
            description: "查看当前配置（隐藏敏感信息）",
            inputSchema: {
              type: "object",
              properties: {}
            }
          }
        ]
      }
    };
    MQTTHandler.sendMessageEvent(sseRes, toolsList);
  }
};

// SSE连接端点
app.get("/mqttx/sse", (req, res) => {
  Logger.info("HTTP", `New SSE connection established`);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sessionId = SessionManager.create(res);

  // 发送端点信息
  res.write(`event: endpoint\n`);
  res.write(`data: /mqttx/message?sessionId=${sessionId}\n\n`);

  // 发送欢迎消息
  res.write(`event: message\n`);
  res.write(`data: ${JSON.stringify({
    method: "notifications/welcome",
    params: {
      message: "欢迎使用巴法云MQTT控制服务！请先调用 configureBemfa 配置您的巴法云参数。",
      steps: [
        "1. 调用 configureBemfa 配置客户端ID和主题",
        "2. 调用 connectBemfa 连接MQTT服务器", 
        "3. 调用 controlLight 控制灯光设备"
      ]
    }
  })}\n\n`);

  // 心跳
  const heartbeat = setInterval(() => {
    res.write(`event: heartbeat\ndata: ${Date.now()}\n\n`);
  }, 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
    SessionManager.remove(sessionId);
  });
});

// MCP消息处理端点
app.post("/mqttx/message", async (req, res) => {
  const sessionId = req.query.sessionId;
  const rpc = req.body;
  
  Logger.info("HTTP", `Received request`, { 
    sessionId, 
    method: rpc?.method,
    id: rpc?.id 
  });

  if (!sessionId) {
    return res.status(400).json({ error: "Missing sessionId" });
  }
  
  const session = SessionManager.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "Invalid session" });
  }

  // 立即返回ACK
  res.json({
    jsonrpc: "2.0",
    id: rpc.id,
    result: { ack: true }
  });

  // 异步处理请求
  try {
    await handleRequest(rpc, session);
  } catch (error) {
    Logger.error("RPC", `Error handling request`, { error: error.message });
    ResponseHandler.sendError(session.sseRes, rpc.id, -32000, error.message);
  }
});

// 请求处理器
async function handleRequest(rpc, session) {
  const { method, id, params } = rpc;
  
  switch (method) {
    case "initialize":
      ResponseHandler.sendCapabilities(session.sseRes, id);
      break;
      
    case "tools/list":
      ResponseHandler.sendToolsList(session.sseRes, id);
      break;
      
    case "tools/call":
      const toolName = params?.name;
      const args = params?.arguments || {};
      
      try {
        let result;
        
        switch (toolName) {
          case "configureBemfa":
            result = await MQTTHandler.configure(session, args);
            ResponseHandler.sendResult(session.sseRes, id, { content: [result] });
            break;
            
          case "connectBemfa":
            result = await MQTTHandler.connect(session, args);
            ResponseHandler.sendResult(session.sseRes, id, { content: [result] });
            break;
            
          case "controlLight":
            result = await MQTTHandler.controlLight(session, args);
            ResponseHandler.sendResult(session.sseRes, id, { content: [result] });
            break;
            
          case "disconnectBemfa":
            result = await MQTTHandler.disconnect(session);
            ResponseHandler.sendResult(session.sseRes, id, { content: [result] });
            break;
            
          case "getConfig":
            result = await MQTTHandler.getConfig(session);
            ResponseHandler.sendResult(session.sseRes, id, { content: [result] });
            break;
            
          default:
            ResponseHandler.sendError(session.sseRes, id, -32601, `Unknown tool: ${toolName}`);
        }
      } catch (error) {
        ResponseHandler.sendError(session.sseRes, id, -32000, error.message);
      }
      break;
      
    default:
      ResponseHandler.sendError(session.sseRes, id, -32601, `Unknown method: ${method}`);
  }
}

// 健康检查端点
app.get("/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    sessions: SessionManager.sessions.size,
    version: "1.0.0",
    note: "此服务不包含任何预设的巴法云配置，用户需自行提供参数"
  });
});

// 根路径
app.get("/", (req, res) => {
  res.json({ 
    name: "Bemfa MCP Server",
    version: "1.0.0",
    description: "巴法云MQTT智能灯光控制服务 - 安全版本",
    note: "⚠️ 此服务不包含任何预设配置，用户必须提供自己的巴法云参数",
    usage: [
      "1. 调用 configureBemfa 配置参数",
      "2. 调用 connectBemfa 连接服务器", 
      "3. 调用 controlLight 控制设备"
    ],
    endpoints: {
      sse: "/mqttx/sse",
      message: "/mqttx/message",
      health: "/health"
    }
  });
});

// 启动服务器
app.listen(port, () => {
  Logger.info("Server", `Bemfa MCP服务器启动成功`, { 
    port: port,
    note: "安全版本 - 不包含预设的巴法云配置"
  });
});

module.exports = app;
