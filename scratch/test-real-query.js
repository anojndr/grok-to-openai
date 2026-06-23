import dotenv from 'dotenv';
import { GrokClient } from '../src/grok/client.js';

dotenv.config();

async function main() {
  const config = {
    grokBaseUrl: process.env.GROK_BASE_URL || 'https://grok.com',
    grokCookieFile: process.env.GROK_COOKIE_FILE || '.grok.cookies.txt',
    browserProfileDir: process.env.BROWSER_PROFILE_DIR || '.browser-profile',
    headless: process.env.HEADLESS !== 'false',
    chromeExecutablePath: process.env.CHROME_EXECUTABLE_PATH || undefined,
    defaultModel: process.env.DEFAULT_MODEL || 'grok-4.3-auto',
    importCookiesOnBoot: process.env.IMPORT_COOKIES_ON_BOOT === 'true',
  };

  console.log("Config loaded:", {
    grokBaseUrl: config.grokBaseUrl,
    grokCookieFile: config.grokCookieFile,
    browserProfileDir: config.browserProfileDir,
    headless: config.headless,
  });

  const client = new GrokClient(config);

  try {
    console.log("Initializing client and sending test request to Grok...");
    let responseText = "";
    const response = await client.createConversationAndRespond({
      instructions: "You are a helpful assistant.",
      model: "grok-4.3-auto",
      message: "Hello! Reply with exactly the words 'Bypassed anti bot' and nothing else.",
      fileAttachments: [],
      onToken: (token) => {
        responseText += token;
        process.stdout.write(token);
      }
    });

    console.log("\n\nResponse completed successfully!");
    console.log("Conversation ID:", response.state.conversation?.conversationId);
    console.log("Response Text:", responseText);
  } catch (error) {
    console.error("\nError occurred:", error);
  } finally {
    await client.close();
  }
}

main();
