const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const mqtt = require("mqtt");

// 配置从环境变量读取
const config = {
  bemfaServer: process.env.BEMFA_SERVER || "bemfa.com",
  bemfaPort: parseInt(process.env.BEMFA_PORT) || 9501,
  defaultClientId: process.env.DEFAULT_CLIENT_ID || "1027eaa277d6457fa609c8286749e828",
  defaultTopic: process.env.DEFAULT_TOPIC || "MasterLight002",
  serverPort: parseInt(process.env.SERVER_PORT) || 4000
};

console.log("=== Bemfa MCP Server Starting ===");
console.log("Config:", {
  bemfaServer: config.bemfaServer,
  bemfaPort: config.bemfaPort,
  defaultTopic: config.defaultTopic,
  serverPort: config.serverPort
});

// 简化的Logger
class Logger {
  static info(context, message, data = null) {
    const timestamp = new Date().toISOString();
    let logMessage = `[INFO] [${timestamp}] [${context}] ${message}`;
    if (data) {
      logMessage += ` ${JSON.stringify(data)}`;
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
      connected: false
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
  async connect(session, args) {
    const sessionId = [...SessionManager.sessions].find(([id, s]) => s === session)?.[0];
    
    // 使用配置的默认值或传入参数
    const host = args.host || config.bemfaServer;
    const port = args.port || config.bemfaPort;
    const clientId = args.clientId || config.defaultClientId;
    const topic = args.topic || config.defaultTopic;
    
    Logger.info("MQTT", `Connecting to Bemfa cloud`, { host, port, clientId, topic });
    
    // 断开之前的连接
    if (session.mqttClient) {
      session.mqttClient.end();
    }
    
    const options = {
      clientId: clientId,
      clean: true
    };
    
    const url = `mqtt://${host}:${port}`;
    
    try {
      const client = mqtt.connect(url, options);
      
      return new Promise((resolve, reject) => {
        client.once('connect', () => {
          Logger.info("MQTT", `Connected to Bemfa cloud`, { sessionId });
          session.mqttClient = client;
          session.connected = true;
          session.currentTopic = topic;
          
          // 订阅主题
          client.subscribe(topic, (err) => {
            if (err) {
              Logger.error("MQTT", `Subscribe error`, { error: err.message });
            } else {
              Logger.info("MQTT", `Subscribed to topic`, { topic });
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
            text: `✅ 成功连接到巴法云MQTT服务器，主题: ${topic}`
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
    
    const command = args.command; // on, off, toggle, status
    const topic = session.currentTopic || config.defaultTopic;
    
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
          resolve({
            type: "text",
            text: "✅ 已断开MQTT连接"
          });
        }
      });
    });
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
          version: "1.0.0"
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
            name: "connectBemfa",
            description: "连接到巴法云MQTT服务器",
            inputSchema: {
              type: "object",
              properties: {
                host: { type: "string", description: "MQTT服务器地址", default: config.bemfaServer },
                port: { type: "number", description: "MQTT端口", default: config.bemfaPort },
                clientId: { type: "string", description: "客户端ID", default: config.defaultClientId },
                topic: { type: "string", description: "主题名称", default: config.defaultTopic }
              }
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
                  description: "控制命令" 
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
    version: "1.0.0"
  });
});

// 根路径
app.get("/", (req, res) => {
  res.json({ 
    name: "Bemfa MCP Server",
    version: "1.0.0",
    description: "巴法云MQTT智能灯光控制MCP服务器",
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
    bemfaServer: config.bemfaServer,
    defaultTopic: config.defaultTopic
  });
});

module.exports = app;
