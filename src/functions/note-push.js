const { app } = require('@azure/functions');
const crypto = require('crypto');

function requireEnv(name) {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env: ${name}`);
    return v;
}

function formatTokyoParts(date = new Date()) {
    // Use formatToParts to avoid locale parsing issues.
    const dtf = new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
    const parts = dtf.formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    const yyyy = get('year');
    const yy = yyyy?.slice(-2);
    const mm = get('month');
    const dd = get('day');
    const HH = get('hour');
    const MM = get('minute');
    const SS = get('second');
    return { yyyy, yy, mm, dd, HH, MM, SS, date: `${yyyy}-${mm}-${dd}` };
}

function buildNotePath(template, tokyoParts) {
    // Supported placeholders: {yyyy} {yy} {mm} {dd} {date}
    return template
        .replaceAll('{yyyy}', tokyoParts.yyyy)
        .replaceAll('{yy}', tokyoParts.yy)
        .replaceAll('{mm}', tokyoParts.mm)
        .replaceAll('{dd}', tokyoParts.dd)
        .replaceAll('{date}', tokyoParts.date);
}

function verifyLineSignature(rawBody, signatureHeader, channelSecret) {
    if (!signatureHeader) return false;
    const hmac = crypto.createHmac('sha256', channelSecret);
    hmac.update(rawBody, 'utf8');
    const expected = hmac.digest('base64');
    // timingSafeEqual expects same length buffers
    const a = Buffer.from(expected);
    const b = Buffer.from(signatureHeader);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

async function githubRequest(url, { method = 'GET', token, body, headers = {} }) {
    const res = await fetch(url, {
        method,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...headers,
        },
        body,
    });
    return res;
}

async function getGitHubFile({ owner, repo, path, branch, token }) {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}?ref=${encodeURIComponent(branch)}`;
    const res = await githubRequest(url, { token });
    if (res.status === 404) return { exists: false };
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub GET failed (${res.status}): ${text}`);
    }
    const json = await res.json();
    const content = Buffer.from(json.content || '', 'base64').toString('utf8');
    return { exists: true, sha: json.sha, content };
}

async function putGitHubFile({ owner, repo, path, branch, token, content, sha, message }) {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}`;
    const body = {
        message,
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch,
        ...(sha ? { sha } : {}),
    };
    const res = await githubRequest(url, {
        method: 'PUT',
        token,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub PUT failed (${res.status}): ${text}`);
    }
    return await res.json();
}

function ensureEndsWithNewline(s) {
    if (!s) return '\n';
    return s.endsWith('\n') ? s : `${s}\n`;
}

app.http('note-push', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        // GET: health check
        if (request.method === 'GET') {
            return { status: 200, jsonBody: { ok: true, name: 'note-push' } };
        }

        // LINE webhook signature validation needs raw body
        const rawBody = await request.text();
        const channelSecret = requireEnv('LINE_CHANNEL_SECRET');
        const signature = request.headers.get('x-line-signature');
        if (!verifyLineSignature(rawBody, signature, channelSecret)) {
            context.log('Invalid LINE signature');
            return { status: 401, jsonBody: { ok: false, error: 'Invalid signature' } };
        }

        let payload;
        try {
            payload = JSON.parse(rawBody);
        } catch {
            return { status: 400, jsonBody: { ok: false, error: 'Invalid JSON' } };
        }

        const events = Array.isArray(payload?.events) ? payload.events : [];
        const textMessages = events
            .filter((e) => e?.type === 'message' && e?.message?.type === 'text')
            .map((e) => ({
                text: String(e.message.text ?? ''),
                userId: e?.source?.userId ? String(e.source.userId) : null,
            }))
            .filter((m) => m.text.trim().length > 0);

        // Always respond 200 quickly for LINE; still return details for logs.
        if (textMessages.length === 0) {
            return { status: 200, jsonBody: { ok: true, appended: 0 } };
        }

        const ghToken = requireEnv('GITHUB_TOKEN');
        const owner = process.env.GITHUB_OWNER || 'KijimaMotofumi';
        const repo = process.env.GITHUB_REPO || 'note';
        const branch = process.env.GITHUB_BRANCH || 'main';
        const template = process.env.NOTE_FILE_PATH_TEMPLATE || 'daily/{date}.md';

        const t = formatTokyoParts();
        const path = buildNotePath(template, t);

        const lines = textMessages.map((m) => {
            // Minimal, grep-friendly format
            // Example: - 14:03 message text
            const time = `${t.HH}:${t.MM}`;
            return `- ${time} ${m.text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')}`;
        });

        const entry = `${lines.join('\n')}\n`;
        const commitMsg = `note: append from LINE (${t.date})`;

        // Retry on SHA conflicts (race conditions when multiple messages arrive)
        let lastErr;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const cur = await getGitHubFile({ owner, repo, path, branch, token: ghToken });
                let nextContent;
                if (!cur.exists) {
                    nextContent = `# ${t.date}\n\n${entry}`;
                } else {
                    nextContent = ensureEndsWithNewline(cur.content) + entry;
                }
                await putGitHubFile({
                    owner,
                    repo,
                    path,
                    branch,
                    token: ghToken,
                    content: nextContent,
                    sha: cur.exists ? cur.sha : undefined,
                    message: commitMsg,
                });

                return { status: 200, jsonBody: { ok: true, appended: textMessages.length, path } };
            } catch (e) {
                lastErr = e;
                // Common conflict code: 409
                const msg = String(e?.message || e);
                const isConflict = msg.includes('(409)') || msg.includes('409');
                if (!isConflict || attempt === 3) break;
                await new Promise((r) => setTimeout(r, 150 * attempt));
            }
        }

        context.log('Failed to append note:', lastErr?.message || lastErr);
        // LINE requires 200 to stop retries, but you may prefer 500 if you want LINE to retry.
        // Here we return 200 with error so LINE won't spam; check Function logs for details.
        return { status: 200, jsonBody: { ok: false, error: 'append_failed', detail: String(lastErr?.message || lastErr), path } };
    },
});
