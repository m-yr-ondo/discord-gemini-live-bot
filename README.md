# Discord Voice & Text Bot trial beta

This Discord bot allows users to interact with  **Gemini** AI through both **real-time voice conversations** in voice channels and **text-based chat** in text channels.

## Features

*   **Real-Time Voice Interaction:**
    *   Join a voice channel and talk naturally to the bot (Levi) you can change the name if you want.
    *   The bot listens via Discord voice, sends audio to the *Live API*.
    *   Visual feedback: Bot appears muted while processing and unmuted when ready to listen.
*   **Text-Based Chat:**
    *   Interact with the bot via text commands (`!levi <your message>` or `/levi <your message>`).
    *   Maintains conversation history ( 30 turns(*can be adjusted*) per text channel for contextual replies.
    *   you can also use user commands if you need discord developer badge.
    *   more at **https://support-dev.discord.com/hc/en-us/articles/10113997751447-Active-Developer-Badge**
*   **Separate Pipelines:** Voice and text functionalities operate independently, ensuring no interference between them.

## Demo

*will think of one eventually*

## Requirements

1.  **Node.js:** Version 18 or higher (e.g., 20.x, 22.x). Tested with v22.18.0.
2.  **npm:** Package manager for Node.js (usually bundled with Node.js).
3.  **ffmpeg:** Installed and accessible in your system's PATH. Used for real-time audio format conversion.
    *   Installation (Ubuntu/Debian): `sudo apt install ffmpeg`
    *   Installation (Other OS): Refer to [FFmpeg Download](https://ffmpeg.org/download.html)
4.  **Discord Bot Token:**
    *   Create an application on the [Discord Developer Portal](https://discord.com/developers/applications).
    *   Create a bot user for the application and copy its token.
5.  **Google Cloud API Key:**
    *   Obtain an API key from [Google AI Studio](https://aistudio.google.com/) or Google Cloud Console with access to the **Gemini API**

## Setup & Installation

1.  **Clone the Repository:**
    ```bash
    git clone https://github.com/m-yr-ondo/discord-gemini-live-bot.git
    cd discord-gemini-live-bot
    ```
2.  **Install Dependencies:**
    ```bash
    npm install
    ```
3.  **Configure Environment Variables:**
    *   Create a `.env` file in the project root directory.
    *   Add your tokens:
        ```
        DISCORD_BOT_TOKEN=your_actual_discord_bot_token_here
        GEMINI_API_KEY=your_actual_gemini_api_key_here
        ```
4.  **Verify `ffmpeg`:**
    Ensure `ffmpeg` is installed and can be run from the command line:
    ```bash
    ffmpeg -version
    ```

## Running the Bot

:

```bash
node index.js

