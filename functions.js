/** Workers-shaped routes for Tool SAM → env.TOOL (DEC-022). */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function error(message, status = 400, code = "bad_request") {
  return json({ error: message, code }, status);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function requireTool(env) {
  if (!env?.TOOL) {
    throw Object.assign(new Error("env.TOOL 不可用（僅掛載為工具時可呼叫）"), {
      code: "tool_inactive",
    });
  }
  return env.TOOL;
}

function apiSubpath(pathname) {
  const marker = "/api";
  const idx = pathname.indexOf(marker);
  if (idx < 0) return pathname || "/";
  return pathname.slice(idx + marker.length) || "/";
}

function toolError(e) {
  const code =
    e && typeof e === "object" && "code" in e ? String(e.code) : "error";
  const status =
    code === "not_found"
      ? 404
      : code === "forbidden" || code === "tool_inactive"
        ? 403
        : code === "conflict"
          ? 409
          : 400;
  return error(e instanceof Error ? e.message : String(e), status, code);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = apiSubpath(url.pathname);
    const method = request.method.toUpperCase();

    try {
      if (path === "/health" && method === "GET") {
        return json({
          ok: true,
          name: "pg-wfedit",
          tool: Boolean(env?.TOOL),
        });
      }

      const TOOL = requireTool(env);

      if (path === "/tool/meta" && method === "GET") {
        return json({
          apiVersion: await TOOL.apiVersion(),
          capabilities: await TOOL.capabilities(),
        });
      }
      if (path === "/tool/grant" && method === "GET") {
        return json(await TOOL.getGrant());
      }
      if (path === "/tool/file" && method === "GET") {
        const filePath = url.searchParams.get("path");
        if (!filePath) return error("缺少 path");
        return json(await TOOL.readFile(filePath));
      }
      if (path === "/tool/file" && method === "PUT") {
        const body = await readJson(request);
        if (!body?.path || typeof body.content !== "string") {
          return error("需要 path 與 content 字串");
        }
        return json(
          await TOOL.writeFile(body.path, body.content, {
            expectedHash: body.expectedHash,
          })
        );
      }
      if (path === "/tool/close" && method === "POST") {
        const body = await readJson(request);
        return json(await TOOL.close({ dirty: Boolean(body?.dirty) }));
      }

      return error("找不到路由", 404, "not_found");
    } catch (e) {
      return toolError(e);
    }
  },
};
