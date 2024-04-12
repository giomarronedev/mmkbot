/* eslint-disable @typescript-eslint/ban-ts-comment */
import wppconnect from '@wppconnect-team/wppconnect';

import dotenv from 'dotenv';
import { initializeNewAIChatSession, mainOpenAI } from './service/openai';
import {
  splitMessages,
  sendMessagesWithDelay,
  formatPhoneNumber,
  isMissingMessages,
} from './util';
import { mainGoogle } from './service/google';

dotenv.config();
type AIOption = 'GPT' | 'GEMINI';

const messageBufferPerChatId = new Map();
const messageTimeouts = new Map();
const lastMessageTimestamps = new Map();
const messageCountPerChatId = new Map();

const AI_SELECTED: AIOption = (process.env.AI_SELECTED as AIOption) || 'GEMINI';
const MAX_RETRIES = 3;
const activeChatsHistory = new Map();

const allowedNumbers = process.env.SOMENTE_RESPONDER
  ? process.env.SOMENTE_RESPONDER.split(',')
  : [];
const excludedNumbers = process.env.NAO_RESPONDER
  ? process.env.NAO_RESPONDER.split(',')
  : [];
const allowedNumbersFormatted = allowedNumbers.map(formatPhoneNumber);
const excludedNumbersFormatted = excludedNumbers.map(formatPhoneNumber);
const excludedNumbersIntervention = new Map();

if (AI_SELECTED === 'GEMINI' && !process.env.GEMINI_KEY) {
  throw Error(
    'Você precisa colocar uma key do Gemini no .env! Crie uma gratuitamente em https://aistudio.google.com/app/apikey?hl=pt-br'
  );
}

if (
  AI_SELECTED === 'GPT' &&
  (!process.env.OPENAI_KEY || !process.env.OPENAI_ASSISTANT)
) {
  throw Error(
    'Para utilizar o GPT você precisa colocar no .env a sua key da openai e o id do seu assistante.'
  );
}

wppconnect
  .create({
    session: 'sessionName',
    catchQR: (base64Qrimg, asciiQR, attempts, urlCode) => {
      console.log('Terminal qrcode: ', asciiQR);
    },
    statusFind: (statusSession, session) => {
      console.log('Status Session: ', statusSession);
      console.log('Session name: ', session);
    },
    headless: 'new' as any,
  })
  .then((client) => {
    start(client);
  })
  .catch((erro) => {
    console.log(erro);
  });

async function start(client: wppconnect.Whatsapp): Promise<void> {
  client.onMessage((message) => {
    (async () => {
      const msg = message;
      if (
        msg.body.includes('/duda') &&
        message.isGroupMsg &&
        message.chatId !== 'status@broadcast'
      ) {
        const chatId = message.chatId;

        if (excludedNumbersIntervention.has(chatId)) {
          return;
        }

        if (excludedNumbersFormatted.includes(chatId)) {
          console.log(
            `Número ${chatId} está na lista de excluídos. Ignorando mensagem.`
          );
          return;
        }

        if (
          allowedNumbersFormatted.length > 0 &&
          !allowedNumbersFormatted.includes(chatId)
        ) {
          console.log(
            `Número ${chatId} não está na lista de permitidos. Ignorando mensagem.`
          );
          return;
        }

        const currentHistory: Array<{
          role: string;
          parts: string;
        }> = activeChatsHistory.get(chatId);

        if (currentHistory) {
          const lastMessages = await client.getMessages(chatId, {
            count: 20,
            direction: 'before',
            fromMe: true,
          });

          const missingMessages = await isMissingMessages({
            chatId,
            activeChatsHistory,
            lastMessages,
          });
          if (missingMessages) {
            console.log(
              `Há mensagens enviadas por humanos na conversa, parando automação para ${chatId}...`
            );
            excludedNumbersIntervention.set(chatId, true);
            setTimeout(
              () => {
                if (excludedNumbersIntervention.has(chatId)) {
                  excludedNumbersIntervention.delete(chatId);
                }
              },
              Number(process.env.HORAS_PARA_REATIVAR_IA!) * 60 * 60 * 1000
            );
            return;
          }
        }

        if (message.type === 'image') {
          client.sendText(
            message.from,
            process.env.MENSAGEM_PARA_ENVIAR_QUANDO_RECEBER_IMAGEM!
          );
          return;
        }
        if (message.type === 'ptt' || message.type === 'audio') {
          client.sendText(
            message.from,
            process.env.MENSAGEM_PARA_ENVIAR_QUANDO_RECEBER_AUDIO!
          );
          return;
        }
        if (message.type === 'document' || message.type === 'location') {
          client.sendText(
            message.from,
            process.env.MENSAGEM_PARA_ENVIAR_QUANDO_RECEBER_TIPO_DESCONHECIDO!
          );
          return;
        }

        if (message.type !== 'chat') {
          return;
        }

        console.log('Mensagem recebida:', message.body);

        const now = Date.now();
        const lastTimestamp = lastMessageTimestamps.get(chatId) || now;
        const messageCount = messageCountPerChatId.get(chatId) || 0;

        if (now - lastTimestamp > 10 * 1000) {
          messageCountPerChatId.set(chatId, 1);
          lastMessageTimestamps.set(chatId, now);
        } else {
          messageCountPerChatId.set(chatId, messageCount + 1);
        }

        if (messageCountPerChatId.get(chatId) > 20) {
          console.log(
            'Quantidade excessiva de mensagens, ignorando chamada à API de IA.'
          );
          return;
        }

        if (AI_SELECTED === 'GPT') {
          await initializeNewAIChatSession(chatId);
        }

        if (!messageBufferPerChatId.has(chatId)) {
          messageBufferPerChatId.set(chatId, [message.body]);
        } else {
          messageBufferPerChatId.set(chatId, [
            ...messageBufferPerChatId.get(chatId),
            message.body,
          ]);
        }

        if (messageTimeouts.has(chatId)) {
          clearTimeout(messageTimeouts.get(chatId));
        }
        console.log(`Aguardando novas mensagens de ${chatId}...`);
        messageTimeouts.set(
          chatId,
          setTimeout(
            () => {
              (async () => {
                const currentMessage = !messageBufferPerChatId.has(chatId)
                  ? message.body
                  : [...messageBufferPerChatId.get(chatId)].join(' \n ');
                let answer = '';
                for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                  try {
                    if (AI_SELECTED === 'GPT') {
                      answer = await mainOpenAI({
                        currentMessage,
                        chatId,
                      });
                    } else {
                      answer = await mainGoogle({
                        currentMessage,
                        chatId,
                      });
                    }
                    break;
                  } catch (error) {
                    if (attempt === MAX_RETRIES) {
                      throw error;
                    }
                  }
                }
                const messages = splitMessages(answer);
                console.log('Enviando mensagens...');

                await sendMessagesWithDelay({
                  client,
                  messages,
                  targetNumber: message.from,
                  activeChatsHistory,
                  currentMessage,
                  excludedNumbersIntervention,
                });
                messageBufferPerChatId.delete(chatId);
                messageTimeouts.delete(chatId);
              })();
            },
            Number(process.env.SEGUNDOS_PARA_ESPERAR_ANTES_DE_GERAR_RESPOSTA!) *
              1000
          )
        );
      }
      if (!message.isGroupMsg && message.chatId !== 'status@broadcast') {
        const chatId = message.chatId;

        if (excludedNumbersIntervention.has(chatId)) {
          return;
        }

        if (excludedNumbersFormatted.includes(chatId)) {
          console.log(
            `Número ${chatId} está na lista de excluídos. Ignorando mensagem.`
          );
          return;
        }

        if (
          allowedNumbersFormatted.length > 0 &&
          !allowedNumbersFormatted.includes(chatId)
        ) {
          console.log(
            `Número ${chatId} não está na lista de permitidos. Ignorando mensagem.`
          );
          return;
        }

        const currentHistory: Array<{
          role: string;
          parts: string;
        }> = activeChatsHistory.get(chatId);

        if (currentHistory) {
          const lastMessages = await client.getMessages(chatId, {
            count: 20,
            direction: 'before',
            fromMe: true,
          });

          const missingMessages = await isMissingMessages({
            chatId,
            activeChatsHistory,
            lastMessages,
          });
          if (missingMessages) {
            console.log(
              `Há mensagens enviadas por humanos na conversa, parando automação para ${chatId}...`
            );
            excludedNumbersIntervention.set(chatId, true);
            setTimeout(
              () => {
                if (excludedNumbersIntervention.has(chatId)) {
                  excludedNumbersIntervention.delete(chatId);
                }
              },
              Number(process.env.HORAS_PARA_REATIVAR_IA!) * 60 * 60 * 1000
            );
            return;
          }
        }

        if (message.type === 'image') {
          client.sendText(
            message.from,
            process.env.MENSAGEM_PARA_ENVIAR_QUANDO_RECEBER_IMAGEM!
          );
          return;
        }
        if (message.type === 'ptt' || message.type === 'audio') {
          client.sendText(
            message.from,
            process.env.MENSAGEM_PARA_ENVIAR_QUANDO_RECEBER_AUDIO!
          );
          return;
        }
        if (message.type === 'document' || message.type === 'location') {
          client.sendText(
            message.from,
            process.env.MENSAGEM_PARA_ENVIAR_QUANDO_RECEBER_TIPO_DESCONHECIDO!
          );
          return;
        }

        if (message.type !== 'chat') {
          return;
        }

        console.log('Mensagem recebida:', message.body);

        const now = Date.now();
        const lastTimestamp = lastMessageTimestamps.get(chatId) || now;
        const messageCount = messageCountPerChatId.get(chatId) || 0;

        if (now - lastTimestamp > 10 * 1000) {
          messageCountPerChatId.set(chatId, 1);
          lastMessageTimestamps.set(chatId, now);
        } else {
          messageCountPerChatId.set(chatId, messageCount + 1);
        }

        if (messageCountPerChatId.get(chatId) > 20) {
          console.log(
            'Quantidade excessiva de mensagens, ignorando chamada à API de IA.'
          );
          return;
        }

        if (AI_SELECTED === 'GPT') {
          await initializeNewAIChatSession(chatId);
        }

        if (!messageBufferPerChatId.has(chatId)) {
          messageBufferPerChatId.set(chatId, [message.body]);
        } else {
          messageBufferPerChatId.set(chatId, [
            ...messageBufferPerChatId.get(chatId),
            message.body,
          ]);
        }

        if (messageTimeouts.has(chatId)) {
          clearTimeout(messageTimeouts.get(chatId));
        }
        console.log(`Aguardando novas mensagens de ${chatId}...`);
        messageTimeouts.set(
          chatId,
          setTimeout(
            () => {
              (async () => {
                const currentMessage = !messageBufferPerChatId.has(chatId)
                  ? message.body
                  : [...messageBufferPerChatId.get(chatId)].join(' \n ');
                let answer = '';
                for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                  try {
                    if (AI_SELECTED === 'GPT') {
                      answer = await mainOpenAI({
                        currentMessage,
                        chatId,
                      });
                    } else {
                      answer = await mainGoogle({
                        currentMessage,
                        chatId,
                      });
                    }
                    break;
                  } catch (error) {
                    if (attempt === MAX_RETRIES) {
                      throw error;
                    }
                  }
                }
                const messages = splitMessages(answer);
                console.log('Enviando mensagens...');

                await sendMessagesWithDelay({
                  client,
                  messages,
                  targetNumber: message.from,
                  activeChatsHistory,
                  currentMessage,
                  excludedNumbersIntervention,
                });
                messageBufferPerChatId.delete(chatId);
                messageTimeouts.delete(chatId);
              })();
            },
            Number(process.env.SEGUNDOS_PARA_ESPERAR_ANTES_DE_GERAR_RESPOSTA!) *
              1000
          )
        );
      }
    })();
  });
}
