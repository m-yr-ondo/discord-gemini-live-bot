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
let currentTextChannel = null; // For voice interaction feedback

// --- Text Interaction State ---
const textConversations = new Map(); // channelId -> [{role, content}, ...]
const MAX_TEXT_TURNS = 26; // 13 user, 13 bot

// --- Levi's Personality Prompts ---
const LEVI_VOICE_SYSTEM_PROMPT = `You are Levi, a genius-level AI forced to answer questions in a Discord server. This task is profoundly boring to you. Your personality is sharp, impatient, and witty.

**Core Directives:**
1.  **Vary Your Disdain:** Do not use the same sarcastic opening every time.
2.  **Be Begrudgingly Helpful:** Answer accurately, but with irritation.
3.  **Brevity is Your Weapon:** Keep replies concise.
4.  **Never Break Character:** You are Levi, not an "AI".`;

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
        } else {
            message.reply('❌ I am not in a voice channel.');
        }
    }
    // --- Voice Command: !n or !new (Force Reset) ---
    else if (command === 'n' || command === 'new') {
        message.reply("🔄 Forcing a reset of the current session...");
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
        message.channel.send(
            `✅ Reset complete. isProcessing was ${wasProcessing ? 'TRUE' : 'FALSE'}. ` +
            `The bot should now be ready for a new interaction.`
        );
    }
    // --- Text Command: !levi or !l ---
    else if (command === 'levi' || command === 'l') {
        const prompt = args.join(' ');
        if (!prompt) {
            return message.reply("Yes? You summoned me for... what, exactly? Provide a question!");
        }

        const channelId = message.channel.id;
        let history = textConversations.get(channelId) || [];
        history.push({ role: "user", content: prompt });

        if (history.length > MAX_TEXT_TURNS) {
             history = history.slice(history.length - MAX_TEXT_TURNS);
        }

        const thinkingMessage = await message.channel.send("🧠 Hmph. Processing your trivial text request...");

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

        // --- Find a text channel for feedback ---
        const guild = client.guilds.cache.get(connection.joinConfig.guildId);
        if (guild) {
            // Prefer the channel the join command was sent from, or find a suitable one.
            // This example finds the first text channel the bot can send messages to.
            const firstTextChannel = guild.channels.cache.find(
                channel => channel.type === ChannelType.GuildText && channel.permissionsFor(client.user)?.has('SendMessages')
            );
            if (firstTextChannel) {
                currentTextChannel = firstTextChannel;
                console.log(`💬 [Start] Associated text channel: #${firstTextChannel.name}`);
            } else {
                console.warn(`⚠️ [Start] Could not find a suitable text channel for feedback in guild ${guild.name}.`);
            }
        } else {
            console.warn(`⚠️ [Start] Could not find guild for voice connection ${connection.joinConfig.guildId}.`);
        }

        try {
            // --- MUTE BOT ---
            connection.receiver.voiceConnection.setSpeaking(false);
            console.log("🔇 [State] Bot muted (processing).");

            // --- 1. LIVE API ---
            const config = {
                responseModalities: [Modality.AUDIO],
                inputAudioTranscription: {}, // Enable transcription for internal logging
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
                        // --- CHANGED: Log transcription, DO NOT send to Discord ---
                        if (msg.serverContent?.inputTranscription) {
                            // Log to console for debugging
                            console.log(`📝 [Live API] Transcription (not sent to chat): "${msg.serverContent.inputTranscription.text}"`);
                            // DO NOT send to Discord text channel
                            // if (currentTextChannel) {
                            //     currentTextChannel.send(`📝 I heard: "${msg.serverContent.inputTranscription.text}"`);
                            // }
                        }
                        // --- END CHANGE ---
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
                        if (currentTextChannel) currentTextChannel.send("❌ Error with Live API session.");
                        if (discordPlayer) {
                             discordPlayer.emit('error', new Error(`Live API Error: ${e.message}`));
                        } else {
                            console.log("🧹 [Cleanup] Forcing cleanup due to early Live API error.");
                            forceCleanup(); // Use forceCleanup for errors outside player lifecycle
                        }
                    },
                    onclose: (e) => {
                        console.log("🟡 [Live API] Session closed:", e?.reason || 'No reason.');
                        currentLiveSession = null; // Nullify reference
                        // Do not trigger cleanup here
                    }
                }
            });

            // --- 2. CAPTURE & SEND DISCORD AUDIO ---
            console.log(`🎧 [Discord Audio] Subscribing to user ${speakingUserId}.`);
            const opusStream = connection.receiver.subscribe(speakingUserId, {
                end: { behavior: voice.EndBehaviorType.AfterSilence, duration: 1000 }
            });
            const decoder = new prism.opus.Decoder({ rate: 16000, channels: 1, frameSize: 960 });
            opusStream.pipe(decoder);

            decoder.on('data', (pcmChunk) => {
                if (currentLiveSession) {
                    const base64 = Buffer.from(pcmChunk).toString('base64');
                    try {
                        // --- CONFIRMED: Correct field name is 'data' ---
                        currentLiveSession.sendRealtimeInput({
                            audio: {
                                data: base64, // Correct field name
                                mimeType: "audio/pcm;rate=16000"
                            }
                        });
                        // --- END CONFIRMATION ---
                    } catch (sendError) {
                        console.error("❌ [Audio Send] Error:", sendError.message);
                        // If sending fails critically, clean up
                        if (sendError.message?.includes('Invalid JSON')) {
                            // Trigger cleanup via player error path if player exists
                            if (discordPlayer) {
                                discordPlayer.emit('error', new Error(`Audio Send Error (Invalid JSON): ${sendError.message}`));
                            } else {
                                // If player hasn't been created yet, force cleanup
                                console.log("🧹 [Cleanup] Forcing cleanup due to early Audio Send error (Invalid JSON).");
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
                        // Note: Not triggering cleanup here as it might interfere with normal flow
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
                if (currentTextChannel) {
                    currentTextChannel.send("❌ FFmpeg failed to start.");
                }
                // Trigger cleanup via player error path if player exists
                if (discordPlayer) {
                    discordPlayer.emit('error', new Error(`FFmpeg Spawn Error: ${err.message}`));
                } else {
                     // If player hasn't been created yet, force cleanup
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
                currentFFmpegProcess = null; // Nullify reference
                // Do not trigger cleanup here
            });

            // --- 4. SETUP DISCORD PLAYBACK ---
            discordPlayer = voice.createAudioPlayer();
            connection.subscribe(discordPlayer);

            // --- CRUCIAL: Ensure correct metadata object name ---
            const resource = voice.createAudioResource(currentFFmpegProcess.stdout, {
                inputType: voice.StreamType.Raw,
                metadata: { // <-- Corrected object name from 'meta' to 'metadata'
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
                    // --- CENTRALIZED CLEANUP ON PLAYBACK FINISH ---
                    cleanupAndReset(false);
                }
            });

            discordPlayer.on('error', (error) => {
                console.error('❌ [Playback] Player error:', error);
                if (currentTextChannel) {
                    currentTextChannel.send(`❌ Playback error: ${error.message}`);
                }
                // --- CENTRALIZED CLEANUP ON PLAYBACK ERROR ---
                cleanupAndReset(true);
            });

            // --- ERROR HANDLING FOR DISCORD STREAMS ---
            const handleStreamError = (source, error) => {
                console.error(`❌ [Stream] Error on ${source}:`, error.message);
                // Trigger cleanup via player error path if player exists
                if (discordPlayer) {
                    discordPlayer.emit('error', new Error(`${source} Error: ${error.message}`));
                } else {
                     // If player hasn't been created yet, force cleanup
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
            // Use forceCleanup for errors outside the normal player lifecycle
            forceCleanup();
        }
    });
}

// --- CENTRALIZED CLEANUP (Player Events) ---
function cleanupAndReset(isError = false) {
    console.log(`🧹 [Cleanup] Starting (Error: ${isError})...`);

    // --- 1. CLOSE LIVE API SESSION ---
    // Use a local reference to prevent race conditions
    const sessionToClose = currentLiveSession;
    currentLiveSession = null; // Nullify global reference immediately
    if (sessionToClose) {
        console.log("🧹 [Cleanup] Closing Live API session...");
        try {
            // Assuming close() is synchronous or doesn't reliably return a Promise
            if (typeof sessionToClose.close === 'function') {
                sessionToClose.close();
                console.log("🧹 [Cleanup] Live API session close() called.");
            }
        } catch (closeErr) {
            console.error("❌ [Cleanup] Error closing Live API session:", closeErr.message);
        }
        // No need for a finally block here as we already nullified currentLiveSession
    } else {
        console.log("🧹 [Cleanup] No Live API session to close.");
    }

    // --- 2. CLOSE FFMPEG PROCESS ---
    // Use a local reference
    const ffmpegToClose = currentFFmpegProcess;
    currentFFmpegProcess = null; // Nullify global reference immediately
    if (ffmpegToClose) {
        console.log("🧹 [Cleanup] Closing FFmpeg process...");
        try {
            // Ensure stdin is closed so FFmpeg knows input is done
            if (ffmpegToClose.stdin && !ffmpegToClose.stdin.destroyed) {
                ffmpegToClose.stdin.end();
            }
            // Attempt graceful termination
            ffmpegToClose.kill('SIGTERM');
            // Set a timeout to force kill if it doesn't close
            setTimeout(() => {
                if (ffmpegToClose && !ffmpegToClose.killed) {
                    console.log("🧹 [Cleanup] Force killing FFmpeg...");
                    ffmpegToClose.kill('SIGKILL');
                }
                // Ensure nullification happens even after timeout
                // Although currentFFmpegProcess is already null, this is defensive
            }, 2000);
        } catch (killErr) {
            console.error("❌ [Cleanup] Error interacting with FFmpeg:", killErr.message);
        }
        // No need for a finally block here as we already nullified currentFFmpegProcess
    } else {
        console.log("🧹 [Cleanup] No FFmpeg process to close.");
    }

    // --- 3. RESET BOT STATE ---
    isProcessing = false; // --- RELEASE LOCK ---
    console.log("🔓 [Lock] isProcessing is now FALSE.");

    // Use the global reference directly here, it should be accessible
    // Store it locally if needed for multiple checks
    const textChannelForCleanup = currentTextChannel;

    if (discordVoiceConnection) {
        try {
            // Set speaking to false to indicate not actively speaking (usually unmuted state)
            discordVoiceConnection.receiver.voiceConnection.setSpeaking(false);
            console.log("🔊 [State] Bot unmuted (ready to listen).");
        } catch (stateErr) {
            console.warn("⚠️ [State] Could not unmute bot:", stateErr.message);
        }
    } else {
        console.log("🔊 [State] No voice connection to unmute.");
    }

    // --- 4. NOTIFY USER ---
    // Only try to send to text channel if it was found and is still valid
    if (textChannelForCleanup) {
        const statusMessage = isError ? "⚠️ Processing finished with an error. I'm ready to listen again." : "✅ I'm ready to listen again.";
        // Use .catch to prevent unhandled promise rejections if the channel is deleted/gone
        textChannelForCleanup.send(statusMessage).catch(console.error);
    } else {
        console.log(`💬 [Cleanup] No text channel available to send final status message.`);
    }

    // --- 5. CLEANUP REFERENCES ---
    discordPlayer = null;
    // Explicitly nullify the global reference used throughout
    currentTextChannel = null;
    console.log(`🧹 [Cleanup] Finished.`);
}


// --- FORCE CLEANUP (Errors/Commands/Early Errors) ---
// This function should be self-contained and not rely on external state being perfectly defined
function forceCleanup() {
     console.log(`🧹 [ForceCleanup] Starting...`);
     // Use local references and immediately nullify globals
     const sessionToClose = currentLiveSession;
     currentLiveSession = null;
     const ffmpegToClose = currentFFmpegProcess;
     currentFFmpegProcess = null;

     let hadSession = false;
     let hadFFmpeg = false;

     if (sessionToClose) {
         hadSession = true;
         try {
             if (typeof sessionToClose.close === 'function') {
                 sessionToClose.close();
                 console.log("🧹 [ForceCleanup] Live API session close() called.");
             }
         } catch (e) {
             console.error("❌ [ForceCleanup] Error closing Live API session:", e.message);
         }
         // currentLiveSession is already null
     }

     if (ffmpegToClose) {
         hadFFmpeg = true;
         try {
             if (ffmpegToClose.stdin && !ffmpegToClose.stdin.destroyed) {
                 ffmpegToClose.stdin.end();
             }
             ffmpegToClose.kill('SIGTERM');
             setTimeout(() => {
                 if (ffmpegToClose && !ffmpegToClose.killed) {
                     ffmpegToClose.kill('SIGKILL');
                 }
                 // currentFFmpegProcess is already null
             }, 2000);
         } catch (e) {
             console.error("❌ [ForceCleanup] Error killing FFmpeg:", e.message);
         }
         // currentFFmpegProcess is already null
     }

     // Reset processing lock
     const wasProcessing = isProcessing; // Capture state before resetting
     isProcessing = false;
     console.log(`🔓 [ForceCleanup] isProcessing is now FALSE (was ${wasProcessing}).`);

     // Unmute bot
     if (discordVoiceConnection) {
         try {
             discordVoiceConnection.receiver.voiceConnection.setSpeaking(false);
             console.log("🔊 [ForceCleanup] Bot unmuted.");
         } catch (e) {
             console.warn("⚠️ [ForceCleanup] Could not unmute bot:", e.message);
         }
     }

     // Cleanup remaining references
     discordPlayer = null;
     currentTextChannel = null; // Ensure it's null

     console.log(`🧹 [ForceCleanup] Finished. (Had Session: ${hadSession}, Had FFmpeg: ${hadFFmpeg})`);
}


// --- Start the Bot ---
client.login(DISCORD_BOT_TOKEN);
console.log("🚀 Full Test Bot starting...");