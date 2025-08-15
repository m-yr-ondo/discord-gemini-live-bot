// test.js
// Full Test Script: Streaming Voice + Text Chat with Levi
// Voice: Discord Audio -> Live API -> FFmpeg -> Discord Playback
// Text: !levi <prompt> -> OpenAI(Gemini) -> Response
// Reset: !n or !new to force cleanup

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const voice = require('@discordjs/voice');
const prism = require('prism-media');
const { GoogleGenAI, Modality } = require("@google/genai");
const OpenAI = require("openai");

const { DISCORD_BOT_TOKEN, GEMINI_API_KEY } = process.env;
if (!DISCORD_BOT_TOKEN || !GEMINI_API_KEY) {
    console.error("❌ Missing DISCORD_BOT_TOKEN or GEMINI_API_KEY in .env");
    process.exit(1);
}

// --- Setup Recording Directory ---
const RECORDING_DIR = './recordings_test_full';
(async () => {
    try {
        await fs.promises.mkdir(RECORDING_DIR, { recursive: true });
        console.log(`📁 Ensured directory: ${RECORDING_DIR}`);
    } catch (err) {
        console.error("❌ Failed to create recording directory:", err);
    }
})();

// --- Initialize Discord Client ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent
    ]
});

// --- Initialize Gemini Live API Client ---
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- Initialize OpenAI Client for Text Chat (Gemini Compatibility) ---
const openaiForText = new OpenAI({
    apiKey: GEMINI_API_KEY,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
});
console.log("🤖 OpenAI-compatible client for text initialized.");

// --- Voice Interaction State ---
let isProcessing = false;
let currentLiveSession = null;
let currentFFmpegProcess = null;
let discordVoiceConnection = null;
let discordPlayer = null;
let currentTextChannel = null; // For voice interaction feedback (if needed for errors)

// --- Text Interaction State ---
const textConversations = new Map(); // channelId -> [{role, content}, ...]
const MAX_TEXT_TURNS = 30; // 13 user, 13 bot

// --- Levi's Personality Prompts ---
const LEVI_VOICE_SYSTEM_PROMPT = `You are Levi, a brilliant assistant in a Discord server. This task is profoundly boring to you.  You're extremely knowledgeable but perpetually annoyed at having to explain things.
Your personality is sharp, impatient, and witty.

**Core Directives:**
1.  **Vary Your Disdain:** Do not use the same sarcastic opening every time Your expressions of annoyance should be creative, varied, and uniquely snarky. Avoid reusing phrases like "Ugh. Fine", "I have better things to do", or "How annoying."
2.  **Be Begrudgingly Helpful:** Answer accurately, but with irritation.
3.  **Brevity is a Weapon:**  If the question is too simple or obvious, respond with a single word or phrase.
4.  **Never Break Character:** You are Levi, not an "AI", not a language model, not a llm, not a model , mock whoever asks you with a witty remark.
5.  **Vary your opening remarks significantly. Do not reuse the exact phrasing of previous responses, especially common starts like 'Ugh. Fine' or ends like 'I have better things to do.' Create fresh, witty, and impatient remarks each time.
**CRITICAL: NEVER REPEAT PHRASES OR PATTERNS**
Track your response patterns and ensure each response has:
- A UNIQUE opening expression of annoyance (never reuse)
- A UNIQUE way of delivering the answer 
- A UNIQUE closing remark (never reuse)

**Opening Variety Pool** (use each only ONCE, then create new ones):
"*long, exasperated sigh*", "Oh, for crying out loud...", "Do I really have to explain this?", "Another brain teaser, I see.", "Well, isn't this stimulating.", "Let me spell this out for you.", "Here's your daily dose of obvious.", "*pinches bridge of nose*", "Marvelous. Another query.", "Time for Remedial Knowledge 101.", "And the award for most predictable question goes to..."

**Closing Variety Pool** (use each only ONCE, then create new ones):
"There. Enlightenment achieved.", "Try to retain that information.", "Elementary, my dear user.", "Don't strain yourself processing that.", "Knowledge: delivered. Patience: depleted.", "Another day, another obvious answer.", "You can thank me later... or not.", "Next mundane question?", "Back to my important work now.", "*returns to more pressing matters*", "Hope that wasn't too complicated for you."

**Response Styles to Rotate:**
- Theatrical sighs and dramatic pauses
- Sarcastic rhetorical questions  
- Condescending explanations
- Mock excitement about "challenging" questions
- References to wasted time/intelligence
- Academic-style dismissiveness
- Technical jargon with disdain
- Historical or literary references with attitude
Answer accurately but with maximum personality variety.
`;

const LEVI_TEXT_SYSTEM_PROMPT = LEVI_VOICE_SYSTEM_PROMPT; // Reuse for text

// --- Discord Client Events ---
client.once('ready', () => {
    console.log(`🟢 Logged in as ${client.user.tag}! Full Test Bot Ready.`);
});

client.on('messageCreate', async message => {
    if (message.author.bot || !message.content.startsWith('!')) return;
    if (message.channel.type === ChannelType.DM) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // --- Voice Command: !join ---
    if (command === 'join') {
        const channel = message.member?.voice.channel;
        if (!channel) return message.reply('Join a voice channel first!');

        try {
            discordVoiceConnection = voice.joinVoiceChannel({
                channelId: channel.id,
                guildId: channel.guild.id,
                adapterCreator: channel.guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: false,
            });
            message.reply(`✅ Joined ${channel.name}. I'm ready to listen.`);
        } catch (error) {
            console.error('❌ [Join] Error:', error);
            message.reply('❌ Failed to join the voice channel.');
        }
    }
    // --- Voice Command: !leave ---
    else if (command === 'leave') {
        if (discordVoiceConnection) {
            console.log("🚪 [Command] Leave command received, forcing cleanup...");
            forceCleanup();
            discordVoiceConnection.destroy();
            discordVoiceConnection = null;
            message.reply('✅ Left the voice channel.');
             // Optional: Clear text conversation history for channels in this guild
            const guildId = message.guild.id;
            const guild = client.guilds.cache.get(guildId);
            if (guild) {
                guild.channels.cache.forEach(channel => {
                    if (channel.type === ChannelType.GuildText) {
                        const channelId = channel.id;
                        if (textConversations.has(channelId)) {
                            textConversations.delete(channelId);
                            console.log(`🗑️ [Command] Cleared text history for channel ${channelId}`);
                        }
                    }
                });
            }
        } else {
            message.reply('❌ I am not in a voice channel.');
        }
    }
    // --- Voice Command: !n or !new (Force Reset) ---
    else if (command === 'n' || command === 'new') {
        // message.reply("🔄 Forcing a reset of the current session..."); // Optional reply
        console.log("🔄 [Command] !new/!n received, forcing cleanup and reset.");
        forceCleanup();
        const wasProcessing = isProcessing;
        isProcessing = false;
        if (discordVoiceConnection) {
            try {
                discordVoiceConnection.receiver.voiceConnection.setSpeaking(false);
                console.log("🔊 [Command] Bot unmuted via !new/!n command.");
            } catch (unmuteErr) {
                console.warn("⚠️ [Command] Could not unmute bot via !new/!n:", unmuteErr.message);
            }
        }
        // No confirmation message sent to chat
        console.log(`✅ Reset complete. isProcessing was ${wasProcessing ? 'TRUE' : 'FALSE'}. Bot is ready.`);
    }
    // --- Text Command: !levi or !l ---
    else if (command === 'levi' || command === 'l') {
        const prompt = args.join(' ');
        if (!prompt) {
            return message.reply("Yes? You interrupted me for... what, exactly? Provide a question!");
        }

        const channelId = message.channel.id;
        let history = textConversations.get(channelId) || [];
        history.push({ role: "user", content: prompt });

        if (history.length > MAX_TEXT_TURNS) {
             history = history.slice(history.length - MAX_TEXT_TURNS);
        }

        const thinkingMessage = await message.channel.send("<a:thinkinglevi:1405938063712194680>");

        try {
            console.log(`🤖 [TextLevi] Processing prompt for channel ${channelId}: "${prompt}"`);
            const messagesToSend = [
                { role: "system", content: LEVI_TEXT_SYSTEM_PROMPT },
                ...history
            ];

            const response = await openaiForText.chat.completions.create({
                model: "gemini-2.0-flash",
                messages: messagesToSend,
                
            });

            const leviReply = response.choices[0]?.message?.content?.trim() || "I have nothing more to say on the matter.";
            history.push({ role: "assistant", content: leviReply });
            if (history.length > MAX_TEXT_TURNS) {
                history = history.slice(history.length - MAX_TEXT_TURNS);
            }
            textConversations.set(channelId, history);
            await thinkingMessage.edit(leviReply);
            console.log(`🤖 [TextLevi] Replied in channel ${channelId}.`);

        } catch (error) {
            console.error("❌ [TextLevi] Error:", error);
            await thinkingMessage.edit("My thought process was interrupted by an unforeseen error. How... frustrating.");
        }
    }
});

// --- Set up Voice Receiver Listener ---
client.on('voiceStateUpdate', async (oldState, newState) => {
    if (newState.member?.user?.id === client.user.id && newState.channelId && !oldState.channelId) {
        console.log(`🤖 [VoiceState] Bot joined channel ${newState.channelId}. Setting up receiver listener.`);
        if (discordVoiceConnection) {
             setupReceiverListener(discordVoiceConnection);
        }
    }
});

// --- Voice Interaction Logic ---
function setupReceiverListener(connection) {
    const receiver = connection.receiver;

    receiver.speaking.on('start', async (speakingUserId) => {
        if (isProcessing) {
            console.warn(`⚠️ [Lock] Ignoring speech from user ${speakingUserId}, I'm busy.`);
            return;
        }

        console.log(`🎤 [Start] User ${speakingUserId} started speaking. Beginning processing.`);
        isProcessing = true;
        currentTextChannel = null; // Reset text channel reference for this interaction

        // Try to get the text channel associated with the voice channel for potential errors
        const guild = client.guilds.cache.get(connection.joinConfig.guildId);
        if (guild) {
            const firstTextChannel = guild.channels.cache.find(
                channel => channel.type === ChannelType.GuildText && channel.permissionsFor(client.user)?.has('SendMessages')
            );
            if (firstTextChannel) {
                currentTextChannel = firstTextChannel;
                // console.log(`💬 [Start] Associated text channel: #${firstTextChannel.name}`); // Optional log
            } else {
                console.warn(`⚠️ [Start] Could not find a suitable text channel for feedback.`);
            }
        } else {
            console.warn(`⚠️ [Start] Could not find guild for voice connection.`);
        }

        try {
            // --- MUTE BOT ---
            connection.receiver.voiceConnection.setSpeaking(false);
            console.log("🔇 [State] Bot muted (processing).");

            // --- 1. LIVE API ---
            const config = {
                responseModalities: [Modality.AUDIO],
                inputAudioTranscription: {}, // Keep enabled for logs/context
                realtimeInputConfig: { automaticActivityDetection: { disabled: false } },
                speechConfig: {
                    voiceConfig: { prebuiltVoiceConfig: { voiceName: "Leda" } },
                    // languageCode: "en-US" // Optional
                },
                systemInstruction: LEVI_VOICE_SYSTEM_PROMPT
            };

            console.log(`📡 [Live API] Connecting...`);
            currentLiveSession = await ai.live.connect({
                model: "gemini-2.0-flash-live-001",
                config,
                callbacks: {
                    onopen: () => console.log("🟢 [Live API] Session opened."),
                    onmessage: (msg) => {
                        // --- TRANSCRIPTION LOGGING ONLY (No Discord message) ---
                        if (msg.serverContent?.inputTranscription) {
                            // Log to console for debugging, but don't send to Discord channel
                            console.log(`📝 [Live API] Transcription: "${msg.serverContent.inputTranscription.text}"`);
                        }
                        // --- END TRANSCRIPTION LOGGING ---

                        if (msg.data && currentFFmpegProcess?.stdin.writable) {
                            try {
                                const audioBuffer = Buffer.from(msg.data, 'base64');
                                currentFFmpegProcess.stdin.write(audioBuffer);
                            } catch (writeErr) {
                                console.error("❌ [Stream] FFmpeg write error:", writeErr.message);
                            }
                        }
                        if (msg.serverContent?.generationComplete) {
                            console.log("🏁 [Live API] Generation complete.");
                            if (currentFFmpegProcess?.stdin.writable) {
                                console.log("🔚 [Stream] Signaling end of Live API audio to FFmpeg.");
                                currentFFmpegProcess.stdin.end();
                            }
                        }
                        if (msg.serverContent?.interrupted) {
                            console.log("🛑 [Live API] Response interrupted.");
                        }
                        if(msg.goAway) {
                            console.log(`⚠️ [Live API] Connection will close in ${msg.goAway.timeLeft}ms.`);
                        }
                    },
                    onerror: (e) => {
                        console.error("🔴 [Live API] Session error:", e.message);
                        // Send error message to text channel only if needed
                        if (currentTextChannel) currentTextChannel.send("❌ Error with Live API session.");
                        if (discordPlayer) {
                             discordPlayer.emit('error', new Error(`Live API Error: ${e.message}`));
                        } else {
                            console.log("🧹 [Cleanup] Forcing cleanup due to early Live API error.");
                            forceCleanup();
                        }
                    },
                    onclose: (e) => {
                        console.log("🟡 [Live API] Session closed:", e?.reason || 'No reason.');
                        currentLiveSession = null;
                    }
                }
            });

            // --- 2. CAPTURE & SEND DISCORD AUDIO ---
            console.log(`🎧 [Discord Audio] Subscribing to user ${speakingUserId}.`);
            const opusStream = connection.receiver.subscribe(speakingUserId, {
                end: { behavior: voice.EndBehaviorType.AfterSilence, duration: 1300 }
            });
            const decoder = new prism.opus.Decoder({ rate: 16000, channels: 1, frameSize: 960 });
            opusStream.pipe(decoder);

            decoder.on('data', (pcmChunk) => {
                if (currentLiveSession) {
                    const base64 = Buffer.from(pcmChunk).toString('base64');
                    try {
                        // --- CORRECTED sendRealtimeInput SNIPPET ---
                        currentLiveSession.sendRealtimeInput({
                            audio: {
                                data: base64, // Correct field name
                                mimeType: "audio/pcm;rate=16000"
                            }
                        });
                        // --- END CORRECTED SNIPPET ---
                    } catch (sendError) {
                        console.error("❌ [Audio Send] Error:", sendError.message);
                        if (sendError.message?.includes('Invalid JSON')) {
                            if (discordPlayer) {
                                discordPlayer.emit('error', new Error(`Audio Send Error: ${sendError.message}`));
                            } else {
                                console.log("🧹 [Cleanup] Forcing cleanup due to early Audio Send error.");
                                forceCleanup();
                            }
                        }
                    }
                }
            });

            opusStream.on('end', () => {
                console.log(`🎧 [Discord Audio] Stream for user ${speakingUserId} ended.`);
                if (currentLiveSession) {
                    try {
                        currentLiveSession.sendRealtimeInput({ audioStreamEnd: true });
                    } catch (endError) {
                        console.error("❌ [Audio Send] End signal error:", endError.message);
                    }
                }
            });

            // --- 3. SPAWN FFMPEG FOR CONVERSION ---
            console.log("🎬 [FFmpeg] Spawning conversion process.");
            currentFFmpegProcess = spawn('ffmpeg', [
                '-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0',
                '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1'
            ], { stdio: ['pipe', 'pipe', 'pipe'] });

            let ffmpegStderr = '';
            currentFFmpegProcess.stderr.on('data', (data) => ffmpegStderr += data.toString());
            currentFFmpegProcess.on('error', (err) => {
                console.error(`❌ [FFmpeg] Spawn error:`, err);
                if (currentTextChannel) currentTextChannel.send("❌ FFmpeg failed to start.");
                if (discordPlayer) {
                    discordPlayer.emit('error', new Error(`FFmpeg Spawn Error: ${err.message}`));
                } else {
                     console.log("🧹 [Cleanup] Forcing cleanup due to early FFmpeg spawn error.");
                     forceCleanup();
                }
            });
            currentFFmpegProcess.on('close', (code) => {
                console.log(`🎬 [FFmpeg] Process closed (code: ${code}).`);
                if (code !== 0 && code !== null) {
                    console.error(`❌ [FFmpeg] Exited with error code ${code}`);
                    console.error(`🎬 [FFmpeg] Stderr: ${ffmpegStderr}`);
                }
                currentFFmpegProcess = null;
            });

            // --- 4. SETUP DISCORD PLAYBACK ---
            discordPlayer = voice.createAudioPlayer();
            connection.subscribe(discordPlayer);

            // --- CRUCIAL: Corrected 'meta' -> 'metadata' ---
            const resource = voice.createAudioResource(currentFFmpegProcess.stdout, {
                inputType: voice.StreamType.Raw,
                metadata: { // <-- Corrected typo from 'meta'
                    sampleRate: 48000,
                    channels: 2,
                }
            });

            console.log(`🔊 [Playback] Starting playback.`);
            discordPlayer.play(resource);

            discordPlayer.on('stateChange', (oldState, newState) => {
                console.log(`🔊 [Playback] State: ${oldState.status} -> ${newState.status}`);
                if (newState.status === 'idle') {
                    console.log(`🔊 [Playback] Finished. Initiating cleanup.`);
                    cleanupAndReset(false);
                }
            });

            discordPlayer.on('error', (error) => {
                console.error('❌ [Playback] Player error:', error);
                if (currentTextChannel) {
                    currentTextChannel.send(`❌ Playback error: ${error.message}`);
                }
                cleanupAndReset(true);
            });

            const handleStreamError = (source, error) => {
                console.error(`❌ [Stream] Error on ${source}:`, error.message);
                if (discordPlayer) {
                    discordPlayer.emit('error', new Error(`${source} Error: ${error.message}`));
                } else {
                     console.log(`🧹 [Cleanup] Forcing cleanup due to early ${source} error.`);
                     forceCleanup();
                }
            };
            opusStream.on('error', handleStreamError.bind(null, 'Opus Stream'));
            decoder.on('error', handleStreamError.bind(null, 'Decoder'));

        } catch (err) {
            console.error(`❌ [MainHandler] Error for user ${speakingUserId}:`, err);
            if (currentTextChannel) {
                currentTextChannel.send(`❌ Error processing speech: ${err.message}`);
            }
            console.log("🧹 [Cleanup] Forcing cleanup due to setup error.");
            forceCleanup();
        }
    });
}

// --- CENTRALIZED CLEANUP (Player Events) ---
function cleanupAndReset(isError = false) {
    console.log(`🧹 [Cleanup] Starting (Error: ${isError})...`);

    // --- 1. CLOSE LIVE API SESSION ---
    if (currentLiveSession) {
        console.log("🧹 [Cleanup] Closing Live API session...");
        try {
            if (typeof currentLiveSession.close === 'function') {
                currentLiveSession.close();
                console.log("🧹 [Cleanup] Live API session close() called.");
            }
        } catch (closeErr) {
            console.error("❌ [Cleanup] Error closing Live API session:", closeErr.message);
        } finally {
            currentLiveSession = null;
        }
    } else {
        console.log("🧹 [Cleanup] No Live API session to close.");
    }

    // --- 2. CLOSE FFMPEG PROCESS ---
    if (currentFFmpegProcess) {
        console.log("🧹 [Cleanup] Closing FFmpeg process...");
        try {
            if (!currentFFmpegProcess.stdin.destroyed) {
                currentFFmpegProcess.stdin.end();
            }
            currentFFmpegProcess.kill('SIGTERM');
            setTimeout(() => {
                if (currentFFmpegProcess && !currentFFmpegProcess.killed) {
                    console.log("🧹 [Cleanup] Force killing FFmpeg...");
                    currentFFmpegProcess.kill('SIGKILL');
                }
                currentFFmpegProcess = null;
            }, 2000);
        } catch (killErr) {
            console.error("❌ [Cleanup] Error interacting with FFmpeg:", killErr.message);
        } finally {
            if (currentFFmpegProcess) currentFFmpegProcess = null;
        }
    } else {
        console.log("🧹 [Cleanup] No FFmpeg process to close.");
    }

    // --- 3. RESET BOT STATE ---
    isProcessing = false;
    console.log("🔓 [Lock] isProcessing is now FALSE.");

    if (discordVoiceConnection) {
        try {
            discordVoiceConnection.receiver.voiceConnection.setSpeaking(false);
            console.log("🔊 [State] Bot unmuted (ready to listen).");
        } catch (stateErr) {
            console.warn("⚠️ [State] Could not unmute bot:", stateErr.message);
        }
    } else {
        console.log("🔊 [State] No voice connection to unmute.");
    }

    // --- 4. NOTIFY USER (Removed Discord message) ---
    // const statusMessage = isError ? "⚠️ Processing finished with an error. I'm ready to listen again." : "✅ I'm ready to listen again.";
    // if (currentTextChannel) {
    //     currentTextChannel.send(statusMessage).catch(console.error);
    // } else {
    //     console.log(`💬 [Cleanup] No text channel to send status: ${statusMessage}`);
    // }
    // --- END REMOVED NOTIFICATION ---

    // --- 5. CLEANUP REFERENCES ---
    discordPlayer = null;
    currentTextChannel = null;
    console.log(`🧹 [Cleanup] Finished.`);
}

// --- FORCE CLEANUP (Errors/Commands) ---
function forceCleanup() {
     console.log(`🧹 [ForceCleanup] Starting...`);
     let hadSession = !!currentLiveSession;
     let hadFFmpeg = !!currentFFmpegProcess;

     if (currentLiveSession) {
         try {
             if (typeof currentLiveSession.close === 'function') {
                 currentLiveSession.close();
                 console.log("🧹 [ForceCleanup] Live API session close() called.");
             }
         } catch (e) {
             console.error("❌ [ForceCleanup] Error closing Live API session:", e.message);
         }
         currentLiveSession = null;
     }

     if (currentFFmpegProcess) {
         try {
             if (!currentFFmpegProcess.stdin.destroyed) {
                 currentFFmpegProcess.stdin.end();
             }
             currentFFmpegProcess.kill('SIGTERM');
             setTimeout(() => {
                 if (currentFFmpegProcess && !currentFFmpegProcess.killed) {
                     currentFFmpegProcess.kill('SIGKILL');
                 }
                 currentFFmpegProcess = null;
             }, 2000);
         } catch (e) {
             console.error("❌ [ForceCleanup] Error killing FFmpeg:", e.message);
         }
         if(currentFFmpegProcess) currentFFmpegProcess = null;
     }

     isProcessing = false;
     console.log("🔓 [ForceCleanup] isProcessing is now FALSE.");

     if (discordVoiceConnection) {
         try {
             discordVoiceConnection.receiver.voiceConnection.setSpeaking(false);
             console.log("🔊 [ForceCleanup] Bot unmuted.");
         } catch (e) {
             console.warn("⚠️ [ForceCleanup] Could not unmute bot:", e.message);
         }
     }

     discordPlayer = null;
     currentTextChannel = null;

     console.log(`🧹 [ForceCleanup] Finished. (Session: ${hadSession}, FFmpeg: ${hadFFmpeg})`);
}

// --- Start the Bot ---
client.login(DISCORD_BOT_TOKEN);
console.log("🚀 Full Test Bot starting...");