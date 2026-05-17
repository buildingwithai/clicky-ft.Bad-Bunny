/**
 * Clicky Proxy Worker
 *
 * Proxies requests to Claude, ElevenLabs, and Fish Audio APIs so the app never
 * ships with raw API keys. Keys are stored as Cloudflare secrets.
 *
 * Routes:
 *   POST /chat  → Anthropic Messages API (streaming)
 *   POST /tts   → ElevenLabs or Fish Audio TTS API
 */

interface Env {
  ANTHROPIC_API_KEY: string;
  ELEVENLABS_API_KEY: string;
  ELEVENLABS_VOICE_ID: string;
  FISH_AUDIO_API_KEY?: string;
  FISH_AUDIO_PRIMARY_REFERENCE_ID?: string;
  FISH_AUDIO_SECONDARY_REFERENCE_ID?: string;
  ASSEMBLYAI_API_KEY: string;
}

type TTSVoiceKey = "elevenlabs-default" | "fish-primary" | "fish-secondary";

interface TTSRequestBody {
  text?: string;
  voice_key?: TTSVoiceKey;
  model_id?: string;
  voice_settings?: unknown;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      if (url.pathname === "/chat") {
        return await handleChat(request, env);
      }

      if (url.pathname === "/tts") {
        return await handleTTS(request, env);
      }

      if (url.pathname === "/transcribe-token") {
        return await handleTranscribeToken(env);
      }
    } catch (error) {
      console.error(`[${url.pathname}] Unhandled error:`, error);
      return new Response(
        JSON.stringify({ error: String(error) }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleChat(request: Request, env: Env): Promise<Response> {
  const body = await request.text();

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[/chat] Anthropic API error ${response.status}: ${errorBody}`);
    return new Response(errorBody, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") || "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

async function handleTranscribeToken(env: Env): Promise<Response> {
  const response = await fetch(
    "https://streaming.assemblyai.com/v3/token?expires_in_seconds=480",
    {
      method: "GET",
      headers: {
        authorization: env.ASSEMBLYAI_API_KEY,
      },
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[/transcribe-token] AssemblyAI token error ${response.status}: ${errorBody}`);
    return new Response(errorBody, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }

  const data = await response.text();
  return new Response(data, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function handleTTS(request: Request, env: Env): Promise<Response> {
  const requestBody = await parseTTSRequestBody(request);
  const voiceKey = requestBody.voice_key || "elevenlabs-default";

  if (voiceKey === "fish-primary" || voiceKey === "fish-secondary") {
    return await handleFishAudioTTS(requestBody, env, voiceKey);
  }

  return await handleElevenLabsTTS(requestBody, env);
}

async function parseTTSRequestBody(request: Request): Promise<TTSRequestBody> {
  const requestBody = await request.json<TTSRequestBody>();

  if (!requestBody.text || typeof requestBody.text !== "string") {
    throw new Error("TTS request requires a text field");
  }

  return requestBody;
}

async function handleElevenLabsTTS(requestBody: TTSRequestBody, env: Env): Promise<Response> {
  const voiceId = env.ELEVENLABS_VOICE_ID;
  const elevenLabsRequestBody = {
    text: requestBody.text,
    model_id: requestBody.model_id || "eleven_flash_v2_5",
    voice_settings: requestBody.voice_settings || {
      stability: 0.5,
      similarity_boost: 0.75,
    },
  };

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": env.ELEVENLABS_API_KEY,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify(elevenLabsRequestBody),
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[/tts] ElevenLabs API error ${response.status}: ${errorBody}`);
    return new Response(errorBody, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") || "audio/mpeg",
    },
  });
}

async function handleFishAudioTTS(
  requestBody: TTSRequestBody,
  env: Env,
  voiceKey: "fish-primary" | "fish-secondary"
): Promise<Response> {
  if (!env.FISH_AUDIO_API_KEY) {
    return new Response(JSON.stringify({ error: "Fish Audio API key is not configured" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const referenceId =
    voiceKey === "fish-primary"
      ? env.FISH_AUDIO_PRIMARY_REFERENCE_ID
      : env.FISH_AUDIO_SECONDARY_REFERENCE_ID;

  if (!referenceId) {
    return new Response(JSON.stringify({ error: `${voiceKey} is not configured` }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const fishAudioRequestBody = {
    text: requestBody.text,
    reference_id: referenceId,
    format: "mp3",
    mp3_bitrate: 128,
    latency: "balanced",
    normalize: true,
  };

  const response = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.FISH_AUDIO_API_KEY}`,
      "content-type": "application/json",
      accept: "audio/mpeg",
      model: "s2-pro",
    },
    body: JSON.stringify(fishAudioRequestBody),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[/tts] Fish Audio API error ${response.status}: ${errorBody}`);
    return new Response(errorBody, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") || "audio/mpeg",
    },
  });
}
