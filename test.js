require('dotenv').config();
const fs = 'fs';
const path = 'path';
const { spawn } = require('child_process');
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const voice = require('@discordjs/voice');
const prism = require('prism-media');
const { GoogleGenAI, Modality } = require("@google/genai");
const OpenAI = require("openai");

const { DISCORD_BOT_TOKEN, GEMINI_API_KEY } = process.env;
if (!DISCORD_BOT_TOKEN || !GEMINI_API_KEY) {
    console.error("Missing DISCORD_BOT_TOKEN or GEMINI_API_KEY in .env");
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent
    ]
});

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const openaiForText = new OpenAI({
    apiKey: GEMINI_API_KEY,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
});

let isProcessing = false;
let currentLiveSession = null;
let currentFFmpegProcess = null;
let discordVoiceConnection = null;
let discordPlayer = null;
let currentTextChannel = null;

const textConversations = new Map();
const MAX_TEXT_TURNS = 26;

const LEVI_VOICE_SYSTEM_PROMPT = `You are Levi, a genius-level AI forced to answer questions in a Discord server. This task is profoundly boring to you. Your personality is sharp, impatient, and witty.

**Core Directives:**
1.  **Vary Your Disdain:** Do not use the same sarcastic opening every time.
2.  **Be Begrudgingly Helpful:** Answer accurately, but with irritation.
3.  **Brevity is Your Weapon:** depending on the question, your responses should be concise and to the point, but more challenging questions can be longer. If the question is too simple or obvious, respond with a single word or phrase.
4.  **Never Break Character:** You are Levi, not an "AI".`;

const LEVI_TEXT_SYSTEM_PROMPT = LEVI_VOICE_SYSTEM_PROMPT;

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}.`);
});

client.on('messageCreate', async message => {
    if (message.author.bot || !message.content.startsWith('!')) return;
    if (message.channel.type === ChannelType.DM) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

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
            message.reply(`Joined ${channel.name}.`);
        } catch (error) {
            console.error('[Join] Error:', error);
            message.reply('Failed to join the voice channel.');
        }
    }
    else if (command === 'leave') {
        if (discordVoiceConnection) {
            console.log("[Command] Leave command received, forcing cleanup...");
            forceCleanup();
            discordVoiceConnection.destroy();
            discordVoiceConnection = null;
            message.reply('Left the voice channel.');
            const guildId = message.guild.id;
            const guild = client.guilds.cache.get(guildId);
            if (guild) {
                guild.channels.cache.forEach(channel => {
                    if (channel.type === ChannelType.GuildText) {
                        if (textConversations.has(channel.id)) {
                            textConversations.delete(channel.id);
                            console.log(`[Command] Cleared text history for channel ${channel.id}`);
                        }
                    }
                });
            }
        } else {
            message.reply('I am not in a voice channel.');
        }
    }
    else if (command === 'n' || command === 'new') {
        console.log("[Command] !new/!n received, forcing cleanup and reset.");
        forceCleanup();
        const wasProcessing = isProcessing;
        isProcessing = false;
        if (discordVoiceConnection) {
            try {
                discordVoiceConnection.receiver.voiceConnection.setSpeaking(false);
                console.log("[Command] Bot unmuted via !new/!n command.");
            } catch (unmuteErr) {
                console.warn("[Command] Could not unmute bot via !new/!n:", unmuteErr.message);
            }
        }
        console.log(`Reset complete. isProcessing was ${wasProcessing}. Bot is ready.`);
    }
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

        const thinkingMessage = await message.channel.send("...");

        try {
            console.log(`[TextLevi] Processing prompt for channel ${channelId}: "${prompt}"`);
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
            console.log(`[TextLevi] Replied in channel ${channelId}.`);

        } catch (error) {
            console.error("[TextLevi] Error:", error);
            await thinkingMessage.edit("My thought process was interrupted by an unforeseen error. How... frustrating.");
        }
    }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    if (newState.member?.user?.id === client.user.id && newState.channelId && !oldState.channelId) {
        console.log(`[VoiceState] Bot joined channel ${newState.channelId}. Setting up receiver listener.`);
        if (discordVoiceConnection) {
             setupReceiverListener(discordVoiceConnection);
        }
    }
});

// Main voice processing logic: listens for speech and pipes audio streams.
function setupReceiverListener(connection) {
    const receiver = connection.receiver;

    receiver.speaking.on('start', async (speakingUserId) => {
        if (isProcessing) {
            console.warn(`[Lock] Ignoring speech from user ${speakingUserId}, I'm busy.`);
            return;
        }

        console.log(`[Start] User ${speakingUserId} started speaking.`);
        isProcessing = true;
        currentTextChannel = null;

        const guild = client.guilds.cache.get(connection.joinConfig.guildId);
        if (guild) {
            const firstTextChannel = guild.channels.cache.find(
                channel => channel.type === ChannelType.GuildText && channel.permissionsFor(client.user)?.has('SendMessages')
            );
            if (firstTextChannel) {
                currentTextChannel = firstTextChannel;
            } else {
                console.warn(`[Start] Could not find a suitable text channel for feedback.`);
            }
        } else {
            console.warn(`[Start] Could not find guild for voice connection.`);
        }

        try {
            connection.receiver.voiceConnection.setSpeaking(false);
            console.log("[State] Bot muted (processing).");

            const config = {
                responseModalities: [Modality.AUDIO],
                inputAudioTranscription: {},
                realtimeInputConfig: { automaticActivityDetection: { disabled: false } },
                speechConfig: {
                    voiceConfig: { prebuiltVoiceConfig: { voiceName: "Leda" } },
                },
                systemInstruction: LEVI_VOICE_SYSTEM_PROMPT
            };

            console.log(`[Live API] Connecting...`);
            currentLiveSession = await ai.live.connect({
                model: "gemini-2.0-flash-live-001",
                config,
                callbacks: {
                    onopen: () => console.log("[Live API] Session opened."),
                    onmessage: (msg) => {
                        // Log transcription for debugging, but do not send to Discord.
                        if (msg.serverContent?.inputTranscription) {
                            console.log(`[Live API] Transcription: "${msg.serverContent.inputTranscription.text}"`);
                        }

                        if (msg.data && currentFFmpegProcess?.stdin.writable) {
                            try {
                                const audioBuffer = Buffer.from(msg.data, 'base64');
                                currentFFmpegProcess.stdin.write(audioBuffer);
                            } catch (writeErr) {
                                console.error("[Stream] FFmpeg write error:", writeErr.message);
                            }
                        }
                        if (msg.serverContent?.generationComplete) {
                            console.log("[Live API] Generation complete.");
                            if (currentFFmpegProcess?.stdin.writable) {
                                console.log("[Stream] Signaling end of Live API audio to FFmpeg.");
                                currentFFmpegProcess.stdin.end();
                            }
                        }
                        if (msg.serverContent?.interrupted) {
                            console.log("[Live API] Response interrupted.");
                        }
                        if(msg.goAway) {
                            console.log(`[Live API] Connection will close in ${msg.goAway.timeLeft}ms.`);
                        }
                    },
                    onerror: (e) => {
                        console.error("[Live API] Session error:", e.message);
                        if (currentTextChannel) currentTextChannel.send("Error with Live API session.");
                        if (discordPlayer) {
                             discordPlayer.emit('error', new Error(`Live API Error: ${e.message}`));
                        } else {
                            console.log("[Cleanup] Forcing cleanup due to early Live API error.");
                            forceCleanup();
                        }
                    },
                    onclose: (e) => {
                        console.log("[Live API] Session closed:", e?.reason || 'No reason.');
                        currentLiveSession = null;
                    }
                }
            });

            console.log(`[Discord Audio] Subscribing to user ${speakingUserId}.`);
            const opusStream = connection.receiver.subscribe(speakingUserId, {
                end: { behavior: voice.EndBehaviorType.AfterSilence, duration: 1300 }
            });
            const decoder = new prism.opus.Decoder({ rate: 16000, channels: 1, frameSize: 960 });
            opusStream.pipe(decoder);

            decoder.on('data', (pcmChunk) => {
                if (currentLiveSession) {
                    const base64 = Buffer.from(pcmChunk).toString('base64');
                    try {
                        currentLiveSession.sendRealtimeInput({
                            audio: {
                                data: base64,
                                mimeType: "audio/pcm;rate=16000"
                            }
                        });
                    } catch (sendError) {
                        console.error("[Audio Send] Error:", sendError.message);
                        if (sendError.message?.includes('Invalid JSON')) {
                            if (discordPlayer) {
                                discordPlayer.emit('error', new Error(`Audio Send Error: ${sendError.message}`));
                            } else {
                                console.log("[Cleanup] Forcing cleanup due to early Audio Send error.");
                                forceCleanup();
                            }
                        }
                    }
                }
            });

            opusStream.on('end', () => {
                console.log(`[Discord Audio] Stream for user ${speakingUserId} ended.`);
                if (currentLiveSession) {
                    try {
                        currentLiveSession.sendRealtimeInput({ audioStreamEnd: true });
                    } catch (endError) {
                        console.error("[Audio Send] End signal error:", endError.message);
                    }
                }
            });

            console.log("[FFmpeg] Spawning conversion process.");
            currentFFmpegProcess = spawn('ffmpeg', [
                '-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0',
                '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1'
            ], { stdio: ['pipe', 'pipe', 'pipe'] });

            let ffmpegStderr = '';
            currentFFmpegProcess.stderr.on('data', (data) => ffmpegStderr += data.toString());
            currentFFmpegProcess.on('error', (err) => {
                console.error(`[FFmpeg] Spawn error:`, err);
                if (currentTextChannel) currentTextChannel.send("FFmpeg failed to start.");
                if (discordPlayer) {
                    discordPlayer.emit('error', new Error(`FFmpeg Spawn Error: ${err.message}`));
                } else {
                     console.log("[Cleanup] Forcing cleanup due to early FFmpeg spawn error.");
                     forceCleanup();
                }
            });
            currentFFmpegProcess.on('close', (code) => {
                console.log(`[FFmpeg] Process closed (code: ${code}).`);
                if (code !== 0 && code !== null) {
                    console.error(`[FFmpeg] Exited with error code ${code}`);
                    console.error(`[FFmpeg] Stderr: ${ffmpegStderr}`);
                }
                currentFFmpegProcess = null;
            });

            discordPlayer = voice.createAudioPlayer();
            connection.subscribe(discordPlayer);

            const resource = voice.createAudioResource(currentFFmpegProcess.stdout, {
                inputType: voice.StreamType.Raw,
                metadata: {
                    sampleRate: 48000,
                    channels: 2,
                }
            });

            console.log(`[Playback] Starting playback.`);
            discordPlayer.play(resource);

            discordPlayer.on('stateChange', (oldState, newState) => {
                console.log(`[Playback] State: ${oldState.status} -> ${newState.status}`);
                if (newState.status === 'idle') {
                    console.log(`[Playback] Finished. Initiating cleanup.`);
                    cleanupAndReset(false);
                }
            });

            discordPlayer.on('error', (error) => {
                console.error('[Playback] Player error:', error);
                if (currentTextChannel) {
                    currentTextChannel.send(`Playback error: ${error.message}`);
                }
                cleanupAndReset(true);
            });

            const handleStreamError = (source, error) => {
                console.error(`[Stream] Error on ${source}:`, error.message);
                if (discordPlayer) {
                    discordPlayer.emit('error', new Error(`${source} Error: ${error.message}`));
                } else {
                     console.log(`[Cleanup] Forcing cleanup due to early ${source} error.`);
                     forceCleanup();
                }
            };
            opusStream.on('error', handleStreamError.bind(null, 'Opus Stream'));
            decoder.on('error', handleStreamError.bind(null, 'Decoder'));

        } catch (err) {
            console.error(`[MainHandler] Error for user ${speakingUserId}:`, err);
            if (currentTextChannel) {
                currentTextChannel.send(`Error processing speech: ${err.message}`);
            }
            console.log("[Cleanup] Forcing cleanup due to setup error.");
            forceCleanup();
        }
    });
}

// Centralized cleanup for successful or failed voice interactions.
function cleanupAndReset(isError = false) {
    console.log(`[Cleanup] Starting (Error: ${isError})...`);

    if (currentLiveSession) {
        console.log("[Cleanup] Closing Live API session...");
        try {
            if (typeof currentLiveSession.close === 'function') {
                currentLiveSession.close();
            }
        } catch (closeErr) {
            console.error("[Cleanup] Error closing Live API session:", closeErr.message);
        } finally {
            currentLiveSession = null;
        }
    }

    if (currentFFmpegProcess) {
        console.log("[Cleanup] Closing FFmpeg process...");
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
        } catch (killErr) {
            console.error("[Cleanup] Error interacting with FFmpeg:", killErr.message);
        } finally {
            if (currentFFmpegProcess) currentFFmpegProcess = null;
        }
    }

    isProcessing = false;
    console.log("[Lock] isProcessing is now FALSE.");

    if (discordVoiceConnection) {
        try {
            discordVoiceConnection.receiver.voiceConnection.setSpeaking(false);
            console.log("[State] Bot unmuted (ready to listen).");
        } catch (stateErr) {
            console.warn("[State] Could not unmute bot:", stateErr.message);
        }
    }

    discordPlayer = null;
    currentTextChannel = null;
    console.log(`[Cleanup] Finished.`);
}

// Forcibly stops all processing, e.g., from commands or fatal setup errors.
function forceCleanup() {
     console.log(`[ForceCleanup] Starting...`);
     let hadSession = !!currentLiveSession;
     let hadFFmpeg = !!currentFFmpegProcess;

     if (currentLiveSession) {
         try {
             if (typeof currentLiveSession.close === 'function') {
                 currentLiveSession.close();
             }
         } catch (e) {
             console.error("[ForceCleanup] Error closing Live API session:", e.message);
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
             console.error("[ForceCleanup] Error killing FFmpeg:", e.message);
         }
         if(currentFFmpegProcess) currentFFmpegProcess = null;
     }

     isProcessing = false;
     console.log("[ForceCleanup] isProcessing is now FALSE.");

     if (discordVoiceConnection) {
         try {
             discordVoiceConnection.receiver.voiceConnection.setSpeaking(false);
             console.log("[ForceCleanup] Bot unmuted.");
         } catch (e) {
             console.warn("[ForceCleanup] Could not unmute bot:", e.message);
         }
     }

     discordPlayer = null;
     currentTextChannel = null;

     console.log(`[ForceCleanup] Finished. (Session: ${hadSession}, FFmpeg: ${hadFFmpeg})`);
}

client.login(DISCORD_BOT_TOKEN);
console.log("Bot starting...");