import express, { type Request, type Response } from "express"; // Revert to default import
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
// McpRequest is not exported, use unknown and type guards/assertions
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { registerContext7Tools } from "./register-context7-tools.js"; // Import Context7 tool registration

// --- 常量定义 ---
const PORT: number = 3000;
const MCP_ENDPOINT: string = "/mcp";
const SESSION_HEADER: string = "mcp-session-id";

// --- 类型定义 ---
interface TransportsMap {
  [sessionId: string]: StreamableHTTPServerTransport;
}

// --- 全局变量 ---
const app = express();
// 使用 Map 存储 transports，键为 session ID
const transports: TransportsMap = {};

// --- 中间件 ---
app.use(express.json());

/**
 * 创建并配置 MCP 服务器实例。
 * @returns {McpServer} 配置好的 MCP 服务器实例。
 */
function createMcpServer(): McpServer {
  const server: McpServer = new McpServer({
    name: "streamable-http-example-server",
    version: "1.0.0",
    capabilities: {
      tools: {}, // 显式声明 capabilities
      resources: {},
      prompts: {}
    }
  });

  // Register Context7 tools onto the same server instance
  registerContext7Tools(server);

  return server;
}

/**
 * 处理 MCP 的 POST 请求，用于客户端到服务器的通信。
 * @param {Request} req - Express 请求对象。
 * @param {Response} res - Express 响应对象。
 */
async function handlePostMcp(req: Request, res: Response): Promise<void> {
  const sessionId: string | undefined = req.headers[SESSION_HEADER] as string | undefined;
  let transport: StreamableHTTPServerTransport | undefined = sessionId ? transports[sessionId] : undefined;
  // Use unknown type for request body initially
  const requestBody: unknown = req.body;

  if (transport) {
    // 重用现有 transport
  } else if (!sessionId && isInitializeRequest(requestBody)) {
    // 新的初始化请求
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: (): string => randomUUID(),
      onsessioninitialized: (newSessionId: string): void => {
        // 存储 transport
        if (transport) { // Type guard
            transports[newSessionId] = transport;
            console.log(`Session initialized: ${newSessionId}`);
        }
      },
    });

    // 会话关闭时清理 transport
    transport.onclose = (): void => {
      if (transport?.sessionId && transports[transport.sessionId]) {
        console.log(`Session closed: ${transport.sessionId}`);
        delete transports[transport.sessionId];
      }
    };

    // 创建并连接 MCP 服务器
    const server: McpServer = createMcpServer();
    try {
        await server.connect(transport);
        console.log("MCP Server connected to transport.");
    } catch (error) {
        console.error("Failed to connect MCP server:", error);
        // 如果连接失败，提前返回错误响应
        if (!res.headersSent) {
            // Safely access id after casting
            const id = (requestBody as { id?: string | number | null })?.id ?? null;
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32001, message: 'Server connection failed' },
                id: id,
            });
        }
        return; // 确保在出错时退出函数
    }

  } else {
    // 无效请求：没有会话 ID 或不是初始化请求
    console.error("Invalid request: No valid session ID or not an initialization request.");
    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: No valid session ID provided or not an initialization request.",
      },
      // Safely access id after casting
      id: (requestBody as { id?: string | number | null })?.id ?? null,
    });
    return;
  }

  // 处理请求
  try {
    await transport.handleRequest(req, res, requestBody);
  } catch (error) {
      console.error("Error handling MCP request:", error);
      // 确保即使在 handleRequest 内部出错也有响应
      if (!res.headersSent) {
          // Safely access id after casting
          const id = (requestBody as { id?: string | number | null })?.id ?? null;
          res.status(500).json({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal server error during request handling' },
              id: id,
          });
      }
  }
}

/**
 * 处理 MCP 的 GET 和 DELETE 请求的通用处理程序。
 * @param {Request} req - Express 请求对象。
 * @param {Response} res - Express 响应对象。
 */
async function handleSessionRequest(req: Request, res: Response): Promise<void> {
  const sessionId: string | undefined = req.headers[SESSION_HEADER] as string | undefined;

  if (!sessionId || !transports[sessionId]) {
    // GET requests without a session ID are often from browsers probing the endpoint.
    // Respond with 405 Method Not Allowed instead of 400 Bad Request.
    if (req.method === 'GET') {
        console.log(`Received GET ${MCP_ENDPOINT} request without a valid session ID. Responding with 405.`);
        res.status(405).json({
            jsonrpc: "2.0",
            error: {
                code: -32000, // Using a generic error code
                message: "Method Not Allowed. This endpoint requires a valid MCP session ID for GET requests (SSE).",
            },
            id: null
        });
    } else {
        // For other methods like DELETE, a missing/invalid session ID is a client error.
        console.error(`Invalid or missing session ID for ${req.method} request: ${sessionId}`);
        res.status(400).send("Invalid or missing session ID");
    }
    return;
  }

  const transport: StreamableHTTPServerTransport = transports[sessionId];
  try {
    await transport.handleRequest(req, res);
  } catch (error) {
      console.error(`Error handling ${req.method} request for session ${sessionId}:`, error);
      // 确保即使在 handleRequest 内部出错也有响应
       if (!res.headersSent) {
          // 对于 GET (SSE)，可能难以发送 JSON 错误，但尝试关闭连接
          if (req.method === 'GET') {
              res.end();
          } else {
             res.status(500).send('Internal server error during request handling');
          }
       }
  }
}

// --- 路由设置 ---
// 处理客户端到服务器的通信
app.post(MCP_ENDPOINT, (req: Request, res: Response) => {
    handlePostMcp(req, res).catch(error => {
        console.error("Unhandled error in POST /mcp:", error);
        if (!res.headersSent) {
            res.status(500).json({ jsonrpc: '2.0', error: { code: -32002, message: 'Unhandled server error' }, id: null });
        }
    });
});

// 处理服务器到客户端的通知 (SSE)
app.get(MCP_ENDPOINT, (req: Request, res: Response) => {
    handleSessionRequest(req, res).catch(error => {
        console.error("Unhandled error in GET /mcp:", error);
        // SSE 连接可能已经建立，尝试结束响应
        if (!res.headersSent) {
            res.end(); // 关闭 SSE 连接
        }
    });
});

// 处理会话终止
app.delete(MCP_ENDPOINT, (req: Request, res: Response) => {
    handleSessionRequest(req, res).catch(error => {
        console.error("Unhandled error in DELETE /mcp:", error);
        if (!res.headersSent) {
            res.status(500).send('Unhandled server error during session termination');
        }
    });
});

// --- 服务器启动 ---
app.listen(PORT, (): void => {
  console.log(`MCP Streamable HTTP Server listening on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}${MCP_ENDPOINT}`);
});

export default app; // 导出 app 实例，虽然在此简单示例中可能不是必需的，但通常是良好实践
