import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CONFIG = {
    apiKey: "",
    apiUrl: "https://api.tavr.top/v1/index.php",
};

let currentConfig = { ...DEFAULT_CONFIG };

function loadConfig(ctx) {
    const configFilePath = ctx.configPath;
    try {
        if (fs.existsSync(configFilePath)) {
            const raw = fs.readFileSync(configFilePath, "utf-8");
            const loaded = JSON.parse(raw);
            currentConfig = { ...DEFAULT_CONFIG, ...loaded };
            ctx.logger.info("[TS-AI] 配置已加载");
        } else {
            saveConfig(ctx, DEFAULT_CONFIG);
        }
    } catch (e) {
        ctx.logger.error("[TS-AI] 加载配置失败", e);
    }
}

function saveConfig(ctx, newConfig) {
    const configFilePath = ctx.configPath;
    try {
        currentConfig = { ...currentConfig, ...newConfig };
        const dir = path.dirname(configFilePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(configFilePath, JSON.stringify(currentConfig, null, 2), "utf-8");
        ctx.logger.info("[TS-AI] 配置已保存");
    } catch (e) {
        ctx.logger.error("[TS-AI] 保存配置失败", e);
    }
}

function buildConfigUI(ctx) {
    const { NapCatConfig } = ctx;
    return NapCatConfig.combine(
        NapCatConfig.html('<div style="padding:10px; border-bottom:1px solid #ccc;"><h3>TS-AI绘画 插件</h3><br>AI地址： <a href="https://ai.tavr.top/">https://ai.tavr.top/</a><br>指令：生图+关键词</div>'),
        NapCatConfig.text("apiKey", "API Key", DEFAULT_CONFIG.apiKey, "请输入您的 API Key (sk-...)"),
        NapCatConfig.text("apiUrl", "API URL", DEFAULT_CONFIG.apiUrl, "API 入口地址")
    );
}

// Helper to call OneBot API
async function callOB11(ctx, action, params) {
    try {
        return await ctx.actions.call(action, params, ctx.adapterName, ctx.pluginManager.config);
    } catch (e) {
        ctx.logger.error(`[TS-AI] Call OB11 ${action} failed:`, e);
    }
}

// Fetch helper
async function callDevApi(endpoint, data = null, method = 'GET') {
    const url = `${currentConfig.apiUrl}?endpoint=${endpoint}`;
    const headers = {
        'x-api-key': currentConfig.apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'NapCat-TSAI/1.0'
    };

    const options = {
        method,
        headers,
    };

    if (data) {
        options.body = JSON.stringify(data);
    }

    try {
        // dynamic import or global fetch (Node 18+)
        const res = await fetch(url, options);
        const json = await res.json();
        return json;
    } catch (e) {
        throw new Error(`API Request Failed: ${e.message}`);
    }
}

async function pollTask(ctx, taskId, groupId) {
    const maxRetries = 60; // 2 minutes
    for (let i = 0; i < maxRetries; i++) {
        await new Promise(r => setTimeout(r, 2000));

        try {
            // Poll status URL constructed based on task_id, or just use endpoint param like script
            // The python script uses: ?endpoint=task_status&task_id=...
            // Note: The task_status endpoint requires task_id in GET param
            // fetch doesn't support params in options body for GET nicely, better append to URL

            // Re-use callDevApi logic but handle GET params
            // Modify callDevApi to accept query params? or just manual
            const url = `${currentConfig.apiUrl}?endpoint=task_status&task_id=${taskId}`;
            const res = await fetch(url, {
                headers: { 'x-api-key': currentConfig.apiKey }
            });
            const json = await res.json();

            if (json.success) {
                const status = json.data.status;
                if (status === 'completed') {
                    const imgUrl = json.data.result.image_url;
                    // Send Image
                    await callOB11(ctx, 'send_group_msg', {
                        group_id: groupId,
                        message: `[CQ:image,file=${imgUrl}]`
                    });
                    // Also send text? Or just image.
                    return;
                } else if (status === 'failed') {
                    await callOB11(ctx, 'send_group_msg', {
                        group_id: groupId,
                        message: `生成失败: ${json.data.error || 'Unknown error'}`
                    });
                    return;
                }
                // Processing... continue
            }
        } catch (e) {
            ctx.logger.error("[TS-AI] Polling error", e);
        }
    }
    await callOB11(ctx, 'send_group_msg', {
        group_id: groupId,
        message: `生成超时 (Task: ${taskId})`
    });
}

async function onMessage(ctx, event) {
    if (event.message_type !== "group") return; // Only group for now or config?

    const msg = event.raw_message?.trim() || "";

    // Command parsing: /draw <prompt>
    if (msg.startsWith("/draw ") || msg.startsWith("生图 ")) {
        const prompt = msg.replace(/^\/draw\s+|trans\s+|生图\s+/, "").trim();
        if (!prompt) return;

        const groupId = event.group_id;
        const user = event.user_id;

        if (!currentConfig.apiKey) {
            await callOB11(ctx, 'send_group_msg', { group_id: groupId, message: "⚠️ 未配置 API Key，请联系管理员配置 TS-AI 插件。" });
            return;
        }

        // Notify accepted
        await callOB11(ctx, 'send_group_msg', { group_id: groupId, message: `已收到生图请求，正在生成: ${prompt}` });

        try {
            // Call Image Generation API (RR3 Workflow)
            const payload = {
                prompt: prompt,
                workflow: "rr3",
                width: 832,
                height: 1216,
                steps: 20
            };

            const result = await callDevApi('image_generation', payload, 'POST');

            if (result.success) {
                const taskId = result.data.id;
                // Poll
                pollTask(ctx, taskId, groupId);
            } else {
                await callOB11(ctx, 'send_group_msg', {
                    group_id: groupId,
                    message: `请求失败: ${result.error || 'Server rejected'}`
                });
            }
        } catch (e) {
            await callOB11(ctx, 'send_group_msg', {
                group_id: groupId,
                message: `系统错误: ${e.message}`
            });
        }
    }
}

// Interface implementation
async function plugin_init(ctx) {
    ctx.logger.info("[TS-AI] 插件加载中...");
    loadConfig(ctx);
    // plugin_config_ui is built on demand or static? Reference uses `buildConfigUI(ctx)` result stored in variable.
    // Wait, reference exports `plugin_config_ui` as an array/object.
    // It calls `plugin_config_ui = buildConfigUI(ctx)` inside init.
    // But export is `export { plugin_config_ui }`.
    // Because ESM exports are bindings, updating the variable works.
}

// We need to export a specific variable that NapCat reads.
// In reference: `let plugin_config_ui = []; ... export { plugin_config_ui ... }`
let plugin_config_ui_obj = [];

async function init_wrapper(ctx) {
    plugin_init(ctx);
    plugin_config_ui_obj = buildConfigUI(ctx);
}

async function plugin_get_config(ctx) {
    return currentConfig;
}

function plugin_on_config_change(ctx, _, key, value) {
    saveConfig(ctx, { [key]: value });
}

export {
    plugin_config_ui_obj as plugin_config_ui,
    init_wrapper as plugin_init,
    plugin_get_config,
    plugin_on_config_change,
    onMessage as plugin_onmessage
};
