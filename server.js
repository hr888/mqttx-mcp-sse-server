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

// Custom Logger
class Logger {
  static LEVELS = {
    DEBUG: { value: 0, label: 'DEBUG', color: '\x1b[36m' },
    INFO: { value: 1, label: 'INFO', color: '\x1b[32m' },
    WARN: { value: 2, label: 'WARN', color: '\x1b[33m' },
    ERROR: { value: 3, label: 'ERROR', color: '\x1b[33m' },
  };
  
  static currentLevel = Logger.LEVELS.INFO;
  
  static formatTime() {
    const now = new Date();
    return now.toISOString();
  }
  
  static formatMessage(level, context, message, data = null) {
    const reset = '\x1b[0m';
    let logMessage = `${level.color}[${level.label}\x1b[0m] [${this.formatTime()}] [${context}] ${message}`;
    
    if (data) {
      if (typeof data === 'object') {
        try {
          const safeJson = JSON.stringify(data, null, 2);
          logMessage += `\n${safeJson}`;
        } catch (e) {
          logMessage += ` [Object: Unable to stringify]`;
        }
      } else {
        logMessage += ` ${data}`;
      }
    }
    
    return logMessage;
  }
  
  static info(context, message, data = null) {
    console.log(this.formatMessage(Logger.LEVELS.INFO, context, message, data));
  }
  
  static error(context, message, error = null) {
    console.error(this.formatMessage(Logger.LEVELS.ERROR, context, message, error));
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
    Logger.info("SessionManager", `New session created: ${sessionId}`);
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
    Logger.info("SessionManager", `Session closed: ${sessionId}`);
  }
};

// MQTT Handler - 专门适配巴法云控制灯光
const MQTTHandler = {
  async connect(session, args) {
    const sessionId = [...SessionManager.sessions].find(([id, s]) => s === session)?.[0];
    
    // 使用配置的默认值或传入参数
    const host = args.host || config.bemfaServer;
    const port = args.port || config.bemfaPort;
    const clientId = args.clientId || config.defaultClientId;
    const topic = args.topic || config.defaultTopic;
    
    Logger.info("MQTT", `Connecting to Bemfa cloud`, { host, port, clientId, topic });
    
    // Disconnect previous client if exists
    if (session.mqttClient) {
      session.mqttClient.end();
    }
    
    // Create connection options
    const options = {
      clientId: clientId,
      clean: true
    };
    
    // Create connection URL
    const url = `mqtt://${host}:${port}`;
    
    try {
      const client = mqtt.connect(url, options);
      
      return new Promise((resolve, reject) => {
        client.once('connect', () => {
          Logger.info("MQTT", `Connected to Bemfa cloud`, { sessionId });
          session.mqttClient = client;
          session.connected = true;
          session.currentTopic = topic;
          
          // Subscribe to the topic
          client.subscribe(topic, (err) => {
            if (err) {
              Logger.error("MQTT", `Subscribe error`, { sessionId, error: err.message });
            } else {
              Logger.info("MQTT", `Subscribed to topic`, { sessionId, topic });
            }
          });
          
          // Handle incoming messages
          client.on('message', (topic, message) => {
            const payload = message.toString();
            Logger.info("MQTT", `Received message`, { topic, payload });
            
            // Send notification to client
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
            text: `成功连接到巴法云MQTT服务器，主题: ${topic}`
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
  
  // 专门针对灯光控制的发布方法
  async controlLight(session, args) {
    if (!session.connected || !session.mqttClient) {
      throw new Error("未连接到MQTT服务器");
    }
    
    const command = args.command; // on, off, toggle, status
    const topic = session.currentTopic || config.defaultTopic;
    
    // 映射命令到巴法云支持的格式
    const commandMap = {
      'on': 'on',
      'off': 'off', 
      'toggle': 'toggle',
      'status': 'status'
    };
    
    const mqttCommand = commandMap[command];
    if (!mqttCommand) {
      throw new Error(`不支持的命令: ${command}`);
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
            text: `已发送${actionText}命令`
          });
        }
      });
    });
  },
  
  async disconnect(session) {
    if (!session.connected || !session.mqttClient) {
      throw new Error("未连接");
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
            text: "已断开MQTT连接"
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
          name: "bemfa-light-controller",
          version: "1.0.0"
        }
      }
    };
    MQTTHandler.sendMessageEvent(sseRes, capabilities);
  },
  
  // 专门为灯光控制优化的工具列表
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
          }
        ]
      }
    };
    MQTTHandler.sendMessageEvent(sseRes, toolsList);
  }
};

/*
 * MCP协议路由
 */

// SSE连接端点
app.get("/mqttx/sse", (req, res) => {
  Logger.info("HTTP", `New SSE connection established`);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sessionId = SessionManager.create(res);

  // Send endpoint information
  res.write(`event: endpoint\n`);
  res.write(`data: /mqttx/message?sessionId=${sessionId}\n\n`);

  // 发送心跳
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
  
  Logger.info("HTTP", `Received ${rpc?.method} request`, { sessionId });

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
            ResponseHandler.sendError(session.sseRes, id, -32601, `未知工具: ${toolName}`);
        }
      } catch (error) {
        ResponseHandler.sendError(session.sseRes, id, -32000, error.message);
      }
      break;
      
    default:
      ResponseHandler.sendError(session.sseRes, id, -32601, `未知方法: ${method}`);
  }
}

// 健康检查端点（魔搭平台需要）
app.get("/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    sessions: SessionManager.sessions.size
  });
});

// 启动服务器
app.listen(port, () => {
  Logger.info("Server", `Bemfa MCP服务器已启动`, { 
    port: port,
    bemfaServer: config.bemfaServer,
    defaultTopic: config.defaultTopic
  });
});

// 导出供测试使用
module.exports = app;
