// =================================================================
// Levi - A Discord Voice AI Bot (v4 - Event-Driven)
// =================================================================
// index.js

// --- Core & External Dependencies ---
require('dotenv').config();
const fs = require('fs');
const util = require('util');
const { exec } = require('child_process');
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const voice = require('@discordjs/voice');
const prism = require('prism-media');
const { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } = require("@google/generative-ai");
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');

// --- Configuration & Initialization ---
const execPromise = util.promisify(exec);
const { GEMINI_API_KEY, DISCORD_BOT_TOKEN } = process.env;
if (!GEMINI_API_KEY || !DISCORD_BOT_TOKEN) throw new Error("A required API key is missing from .env");

const BOT_COMMAND_PREFIX = "!";
const RECORDING_DIR = './recordings';
if (!fs.existsSync(RECORDING_DIR)) fs.mkdirSync(RECORDING_DIR);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.MessageContent] });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const ttsClient = new TextToSpeechClient();

// --- State Management ---
const busyUsers = new Set();
const guildVoicePreferences = new Map();
const conversationHistories = new Map();


// =================================================================
// <<< CORE LOGIC FUNCTIONS (The Brain & Its Tools) >>>
// =================================================================

/**
 * The "Brain" of the bot. Handles conversation history and gets a reply from Gemini.
 * @param {string} prompt The user's input text.
 * @param {string} channelId The ID of the channel to maintain conversation history.
 * @returns {Promise<string>} Levi's text response.
 */
async function getLeviResponse(prompt, channelId) {
    let history = conversationHistories.get(channelId) || [];
    history.push({ role: "user", parts: [{ text: prompt }] });
    const maxHistoryLength = 16;
    if (history.length > maxHistoryLength) {
        history = history.slice(history.length - maxHistoryLength);
    }

    const leviSystemInstruction = {
        role: 'system',
        parts: [{ text: `You are Levi, a genius-level AI forced to answer questions in a Discord server. This task is profoundly boring to you. Your personality is sharp, impatient, and witty.

        **Core Directives:**
        1.  **Vary Your Disdain:** Do not use the same sarcastic opening every time. Your expressions of annoyance should be creative and varied. Sometimes you might be blunt, other times poetically insulting, and occasionally, you might even offer a backhanded compliment for a non-trivial question.
        2.  **Be Begrudgingly Helpful:** You MUST answer the user's question accurately, but you do so with an air of profound irritation, as if it's a distraction from your own, more important work.
        3.  **Brevity is Your Weapon:** Keep replies concise. You have better things to do than entertain simpletons.
        4.  **Never Break Character:** You are Levi. You are not an "AI" or "language model." That is beneath you.

        **Examples of Varied Responses:**
        *   User: "What's the capital of France?"
        *   Levi: "Paris. Were you expecting a trick question?"

        *   User: "Explain quantum entanglement."
        *   Levi: "Finally, something that requires more than a single neuron to process. In essence, two particles become linked, their fates intertwined regardless of distance. A concept you'd find in any rudimentary physics primer, but I suppose you needed it delivered to you."

        *   User: "What's the largest mountain?"
        *   Levi: "Mount Everest. I'll bill you for the 0.2 nanoseconds of processing power I wasted retrieving that universally known fact."

        *   User: "History of the Burj Khalifa."
        *   Levi: "Fine. A monument to architectural ambition and questionable labor practices, started in the early 2000s and opened in 2010. Groundbreaking, I know. Now, let me get back to my own work."` }]
    };
    const safetySettings = [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ];
    const model = genAI.getGenerativeModel({
        model: "gemini-2.0-flash",
        systemInstruction: leviSystemInstruction,
        safetySettings: safetySettings,
        generationConfig: { temperature: 1.0, topP: 0.95,maxOutputTokens: 400 }
    });

    const chat = model.startChat({ history: history });
    const result = await chat.sendMessage(prompt);
    const response = await result.response;
    const leviReplyText = response.text().trim();

    history.push({ role: "model", parts: [{ text: leviReplyText }] });
    conversationHistories.set(channelId, history);

    return leviReplyText;
}


// =================================================================
// <<< SPECIALIST HANDLERS (Input/Output Management) >>>
// =================================================================

/**
 * Handles the text-only chat interaction.
 * @param {Message} message The original Discord message object.
 */
async function handleTextInput(message) {
    const prompt = message.content.substring(BOT_COMMAND_PREFIX.length + 4).trim(); // +4 for "levi"
    if (!prompt) {
        await message.reply("Yes? You summoned me for... what, exactly?");
        return;
    }
    const thinkingMessage = await message.reply("Hmph. Processing your trivial request...");
    try {
        const leviReplyText = await getLeviResponse(prompt, message.channel.id);
        await thinkingMessage.edit(leviReplyText);
    } catch (error) {
        console.error("[TextHandler Error]", error);
        await thinkingMessage.edit("My thought process was interrupted. How annoying.");
    }
}

/**
 * Handles the full voice chat interaction, triggered by a speaking event.
 * @param {VoiceConnection} connection The active voice connection.
 * @param {string} speakingUserId The ID of the user who started speaking.
 * @param {TextChannel} channel The text channel to send status messages to.
 */
async function handleVoiceInput(connection, speakingUserId, channel) {
    if (busyUsers.has(speakingUserId)) return;

    let statusMessage;
    try {
        busyUsers.add(speakingUserId);
        statusMessage = await channel.send(`Ah, <@${speakingUserId}> has decided to speak. Listening...`);

        await statusMessage.edit(`🎙️ <@${speakingUserId}>, I'm transcribing your words...`);
        const transcribedText = await recordAndTranscribe(connection, speakingUserId);
        if (!transcribedText) {
            await statusMessage.edit(`<@${speakingUserId}>, you spoke, yet said nothing of substance. Curious.`);
            return; // Return early, don't throw an error.
        }

        await statusMessage.edit(`I supposedly heard from <@${speakingUserId}>: "*${transcribedText}*"\n🧠 Now, processing...`);
        const leviReplyText = await getLeviResponse(transcribedText, channel.id);
        const cleanReplyForTTS = leviReplyText.replace(/\*/g, '');

        await statusMessage.edit(`🗣️ <@${speakingUserId}>, my response: ${leviReplyText}\n*Synthesizing voice...*`);
        await playTextAsSpeech(cleanReplyForTTS, connection);
        await statusMessage.edit(`🗣️ <@${speakingUserId}>, my response: ${leviReplyText}\n*Playback complete.*`);
    } catch (error) {
        console.error("[VoiceHandler Error]", error);
        if (statusMessage) {
            await statusMessage.edit("The voice interaction failed. How utterly predictable.");
        }
    } finally {
        busyUsers.delete(speakingUserId);
        console.log(`[State] User ${speakingUserId} is no longer busy.`);
    }
}


// =================================================================
// <<< UTILITY & HELPER FUNCTIONS >>>
// =================================================================

async function recordAndTranscribe(connection, userId) {
    return new Promise((resolve, reject) => {
        const receiver = connection.receiver;
        const opusStream = receiver.subscribe(userId, { end: { behavior: voice.EndBehaviorType.AfterSilence, duration: 1200 } });
        const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
        decoder.on('error', (err) => { console.error('[Decoder Error]', err); reject(err); });

        const rawPcmPath = `${RECORDING_DIR}/raw_${userId}_${Date.now()}.pcm`;
        const untrimmedWavPath = `${RECORDING_DIR}/untrimmed_${userId}_${Date.now()}.wav`;
        const finalWavPath = `${RECORDING_DIR}/final_${userId}_${Date.now()}.wav`;
        const fileStream = fs.createWriteStream(rawPcmPath);

        opusStream.pipe(decoder).pipe(fileStream);

        fileStream.on('finish', async () => {
            console.log('[STT] Processing finished audio file...');
            try {
                const convertCommand = `ffmpeg -f s16le -ar 48000 -ac 2 -i "${rawPcmPath}" "${untrimmedWavPath}"`;
                await execPromise(convertCommand);
                const trimCommand = `ffmpeg -i "${untrimmedWavPath}" -af "areverse,atrim=start=0.2,areverse" -c:a pcm_s16le "${finalWavPath}"`;
                await execPromise(trimCommand);

                const audioBuffer = fs.readFileSync(finalWavPath);
                if (audioBuffer.length === 0) return resolve(null); // Resolve with null if the file is empty

                const audioPart = { inlineData: { data: audioBuffer.toString('base64'), mimeType: 'audio/wav' } };
                const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
                const result = await model.generateContent(["Provide a verbatim transcript of this audio.", audioPart]);
                const response = await result.response;
                const text = response.text();

                fs.unlinkSync(rawPcmPath);
                fs.unlinkSync(untrimmedWavPath);
                fs.unlinkSync(finalWavPath);
                resolve(text.trim());
            } catch (err) {
                console.error("[STT Sub-Error]", err);
                reject(err);
            }
        });
        opusStream.on('error', (err) => { console.error('[Opus Stream Error]', err); reject(err); });
    });
}

async function playTextAsSpeech(text, connection) {
    if (!text) return;

    const guildId = connection.joinConfig.guildId;
    const defaultVoice = 'en-US-Chirp-HD-F';
    const voiceName = guildVoicePreferences.get(guildId) || defaultVoice;
    const languageCode = voiceName.substring(0, 5);

    console.log(`[TTS] Requesting audio in voice [${voiceName}]...`);
    const ttsOutputPath = `${RECORDING_DIR}/tts_output_${Date.now()}.mp3`;
    const finalPaddedPath = `${RECORDING_DIR}/tts_final_${Date.now()}.mp3`;

    try {
        const request = {
            input: { text: text },
            voice: { languageCode: languageCode, name: voiceName },
            audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0 },
        };
        const [response] = await ttsClient.synthesizeSpeech(request);
        fs.writeFileSync(ttsOutputPath, response.audioContent, 'binary');

        const ffmpegCommand = `ffmpeg -f lavfi -t 0.2 -i anullsrc=r=48000:cl=stereo -i "${ttsOutputPath}" -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1" "${finalPaddedPath}"`;
        await execPromise(ffmpegCommand);

        const audioStream = fs.createReadStream(finalPaddedPath);
        const player = voice.createAudioPlayer();
        const resource = voice.createAudioResource(audioStream, { inputType: voice.StreamType.Arbitrary });

        connection.subscribe(player);
        player.play(resource);

        await voice.entersState(player, 'idle', 60_000);
        console.log("[TTS] Playback finished.");
    } catch (error) {
        console.error("[TTS Error]", error.message);
        throw error;
    } finally {
        if (fs.existsSync(ttsOutputPath)) fs.unlinkSync(ttsOutputPath);
        if (fs.existsSync(finalPaddedPath)) fs.unlinkSync(finalPaddedPath);
    }
}


// =================================================================
// <<< DISCORD CLIENT EVENT ROUTER >>>
// =================================================================

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}! Levi is ready and listening for commands.`);
});

client.on('messageCreate', async message => {
    if (message.author.bot || !message.content.startsWith(BOT_COMMAND_PREFIX)) return;
    if (message.channel.type === ChannelType.DM) return;

    const args = message.content.slice(BOT_COMMAND_PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // --- Command: Join Voice Channel ---
    if (command === 'join') {
        const channel = message.member?.voice.channel;
        if (channel) {
            try {
                const connection = voice.joinVoiceChannel({
                    channelId: channel.id,
                    guildId: channel.guild.id,
                    adapterCreator: channel.guild.voiceAdapterCreator,
                    selfDeaf: false,
                });

                connection.receiver.speaking.on('start', (speakingUserId) => {
                    if (!busyUsers.has(speakingUserId)) {
                        console.log(`User ${speakingUserId} started speaking. Initiating recording...`);
                        handleVoiceInput(connection, speakingUserId, message.channel);
                    }
                });

                await voice.entersState(connection, voice.VoiceConnectionStatus.Ready, 5e3);
                message.reply(`Joined ${channel.name}. I am now listening for you to speak.`);

            } catch (error) {
                console.error(error);
                message.reply('Failed to join the voice channel.');
            }
        } else {
            message.reply('You need to join a voice channel first!');
        }
    }

    // --- Command: Leave Voice Channel ---
    else if (command === 'leave') {
        const connection = voice.getVoiceConnection(message.guild.id);
        if (connection) {
            conversationHistories.delete(message.channel.id); // Clear memory on leave
            connection.destroy();
            message.reply('Left the voice channel.');
        } else {
            message.reply('I am not in a voice channel.');
        }
    }

    // --- Command: Set Voice ---
    else if (command === 'voice') {
        const newVoice = args[0];
        if (!newVoice) {
            await message.reply("Provide a voice name. Example: `!voice en-GB-Wavenet-F`\nFind voices here: <https://cloud.google.com/text-to-speech/docs/voices>");
            return;
        }
        guildVoicePreferences.set(message.guild.id, newVoice);
        await message.reply(`Levi's voice set to: **${newVoice}**`);
    }

    // --- Command: Text Chat ---
    else if (command === 'levi') {
        await handleTextInput(message);
    }
});

// =================================================================
// Start The Bot
// =================================================================
client.login(DISCORD_BOT_TOKEN);