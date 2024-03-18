/* eslint-disable @typescript-eslint/naming-convention */
import { type ChatSession, GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY!);
const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
const activeChats = new Map();

const getOrCreateChatSession = async (chatId: string): Promise<ChatSession> => {
  if (activeChats.has(chatId)) {
    const currentHistory = activeChats.get(chatId);
    return model.startChat({
      history: currentHistory,
    });
  }
  const history = [
    {
      role: 'user',
      parts: process.env.GEMINI_PROMPT ?? 'oi',
    },
    {
      role: 'model',
      parts: 'Olá, certo!',
    },
  ];
  activeChats.set(chatId, history);
  setTimeout(
    () => {
      if (activeChats.has(chatId)) {
        activeChats.delete(chatId);
        console.log(`Chat ${chatId} expirou e foi removido.`);
      }
    },
    Number(process.env.HORAS_PARA_REATIVAR_IA!) * 60 * 60 * 1000
  );
  return model.startChat({
    history,
  });
};

export const mainGoogle = async ({
  currentMessage,
  chatId,
}: {
  currentMessage: string;
  chatId: string;
}): Promise<string> => {
  const chat = await getOrCreateChatSession(chatId);
  const prompt = currentMessage;
  const result = await chat.sendMessage(prompt);
  const response = result.response;
  console.log({ response });

  const text = response.text();
  console.log({ text });
  activeChats.set(chatId, [
    ...activeChats.get(chatId),
    {
      role: 'user',
      parts: prompt,
    },
    {
      role: 'model',
      parts: text,
    },
  ]);

  console.log('Resposta Gemini: ', text);
  return text;
};
