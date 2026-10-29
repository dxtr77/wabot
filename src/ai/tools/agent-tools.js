// Composition entry point. Tools receive services explicitly; declarations and
// handlers live together in the corresponding domain modules.
import * as sys from '../../commands/system.js';
import * as mc from '../../commands/minecraft.js';
import * as dl from '../../commands/download.js';
import { searchAndSendImages } from '../../commands/image-search.js';
import { cfg } from '../../config.js';
import { searchWeb } from '../../tavily.js';
import { summarizeYouTube } from '../../commands/youtube-summary.js';
import { searchChatHistory } from '../../context/service.js';
import { checkKatimsdService } from '../../commands/service.js';
import { createToolRegistry } from './registry.js';
import { createServiceTools } from './services.js';
import { createConversationTools } from './conversation.js';
import { createMinecraftTools } from './minecraft.js';
import { createServerTools } from './server.js';
import { createWebTools } from './web.js';
import { createMediaTools } from './media.js';

export const { toolDeclarations, availableToolDeclarations, executeAgentTool } = createToolRegistry([
  ...createServiceTools(checkKatimsdService),
  ...createConversationTools(searchChatHistory),
  ...createMinecraftTools(mc),
  ...createServerTools(sys),
  ...createWebTools({ searchWeb, summarizeYouTube }, cfg.tavily.enabled && cfg.tavily.apiKey),
  ...createMediaTools({ searchAndSendImages, download: dl.handle }),
]);
