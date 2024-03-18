/* eslint-disable @typescript-eslint/ban-ts-comment */
import { type Whatsapp, type Message } from '@wppconnect-team/wppconnect';

const allLastMessagesMap = new Map();

export function splitMessages(text: string): string[] {
  const complexPattern =
    /(http[s]?:\/\/[^\s]+)|(www\.[^\s]+)|([^\s]+@[^\s]+\.[^\s]+)|(["'].*?["'])|(\b\d+\.\s)|(\w+\.\w+)/g;
  const placeholders = text.match(complexPattern) ?? [];

  const placeholder = 'PLACEHOLDER_';
  let currentIndex = 0;
  const textWithPlaceholders = text.replace(
    complexPattern,
    () => `${placeholder}${currentIndex++}`
  );

  const splitPattern = /(?<!\b\d+\.\s)(?<!\w+\.\w+)[^.?!]+(?:[.?!]+["']?|$)/g;
  let parts = textWithPlaceholders.match(splitPattern) ?? ([] as string[]);

  if (placeholders.length > 0) {
    parts = parts.map((part) =>
      placeholders.reduce(
        (acc, val, idx) => acc.replace(`${placeholder}${idx}`, val),
        part
      )
    );
  }

  return parts;
}

async function delay(time: number): Promise<unknown> {
  return await new Promise((resolve) => setTimeout(resolve, time));
}

export async function sendMessagesWithDelay({
  messages,
  client,
  targetNumber,
  activeChatsHistory,
  currentMessage,
  excludedNumbersIntervention,
}: {
  messages: string[];
  client: Whatsapp;
  targetNumber: string;
  activeChatsHistory: Map<any, any>;
  currentMessage: string;
  excludedNumbersIntervention: Map<any, any>;
}): Promise<void> {
  for (const [index, msg] of messages.entries()) {
    await delay(1000);
    const lastMessages = await client.getMessages(targetNumber, {
      count: 5,
      direction: 'before',
      fromMe: true,
    });

    console.log(
      'lastMessages',
      lastMessages.map((c) => c.body)
    );

    if (!allLastMessagesMap.has(targetNumber)) {
      console.log('criando novo map');
      allLastMessagesMap.set(targetNumber, []);
    }
    let currentLastMessages = allLastMessagesMap.get(targetNumber);
    console.log({ currentLastMessages });
    const newMessages = lastMessages.filter(
      (message) =>
        !currentLastMessages.some((m: { id: string }) => m.id === message.id)
    );
    console.log({ newMessages });

    currentLastMessages = [...newMessages, ...currentLastMessages]
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(0, 50);
    allLastMessagesMap.set(targetNumber, currentLastMessages);

    console.log({ currentLastMessages });

    const isMissingMessage = await isMissingMessages({
      activeChatsHistory,
      chatId: targetNumber,
      lastMessages: currentLastMessages,
    });

    if (isMissingMessage) {
      console.log(
        'Há mensagens enviadas por humanos na conversa, parando automação...'
      );
      excludedNumbersIntervention.set(targetNumber, true);
      setTimeout(
        () => {
          if (excludedNumbersIntervention.has(targetNumber)) {
            excludedNumbersIntervention.delete(targetNumber);
          }
        },
        Number(process.env.HORAS_PARA_REATIVAR_IA!) * 60 * 60 * 1000
      );

      return;
    }

    await client.startTyping(targetNumber);
    const dynamicDelay = msg.length * 100;
    await new Promise((resolve) => setTimeout(resolve, dynamicDelay));
    client
      .sendText(targetNumber, msg.trimStart().trimEnd())
      .then(async (result) => {
        console.log('Mensagem enviada:', result.body);
        if (activeChatsHistory.has(targetNumber)) {
          const currentHistory = activeChatsHistory.get(targetNumber);

          if (index === messages.length - 1) {
            activeChatsHistory.set(targetNumber, [
              ...currentHistory,
              {
                role: 'user',
                parts: currentMessage,
              },
              {
                role: 'model',
                parts: msg.trimStart().trimEnd(),
              },
            ]);
          } else {
            activeChatsHistory.set(targetNumber, [
              ...currentHistory,
              {
                role: 'model',
                parts: msg.trimStart().trimEnd(),
              },
            ]);
          }
        } else {
          activeChatsHistory.set(targetNumber, [
            {
              role: 'user',
              parts: currentMessage,
            },
            {
              role: 'model',
              parts: msg.trimStart().trimEnd(),
            },
          ]);
          setTimeout(
            () => {
              if (activeChatsHistory.has(targetNumber)) {
                activeChatsHistory.delete(targetNumber);
                console.log(`A IA voltará a responder: ${targetNumber}.`);
              }
            },
            Number(process.env.HORAS_PARA_REATIVAR_IA!) * 60 * 60 * 1000
          );
        }
        await client.stopTyping(targetNumber);
      })
      .catch((erro) => {
        console.error('Erro ao enviar mensagem:', erro);
      });
  }
}

export function formatPhoneNumber(phoneNumber: string): string {
  let cleanNumber = phoneNumber.replace(/\D/g, '');

  if (cleanNumber.length === 13 && cleanNumber.startsWith('55')) {
    cleanNumber = cleanNumber.slice(0, 4) + cleanNumber.slice(5);
  }
  return `${cleanNumber}@c.us`;
}

export async function isMissingMessages({
  chatId,
  activeChatsHistory,
  lastMessages,
}: {
  chatId: string;
  activeChatsHistory: Map<any, any>;
  lastMessages: Message[];
}): Promise<boolean> {
  const currentHistory = activeChatsHistory.get(chatId);

  if (!currentHistory || currentHistory.length === 0) {
    return false;
  }

  const firstFromMeInHistory = currentHistory
    .filter((msg: { role: string }) => msg.role === 'model')
    .shift();

  console.log({ firstFromMeInHistory });

  if (!firstFromMeInHistory) {
    return false;
  }

  // @ts-expect-error
  const indexInLastMessages = lastMessages.findLastIndex(
    (message: Message) =>
      // @ts-expect-error
      message.body === firstFromMeInHistory.parts && message.fromMe
  );

  if (indexInLastMessages === -1) {
    return false;
  }

  const isAnyMessageFromHuman = lastMessages
    .slice(indexInLastMessages)
    // @ts-expect-error
    .filter((message) => message.fromMe)
    .find((message) => {
      const messageWasCorrect = currentHistory
        .filter((c: { role: string }) => c.role === 'model')
        .find((msg: { parts: string }) => {
          return msg.parts === message.body;
        });

      if (messageWasCorrect) return false;

      return true;
    });

  return !!isAnyMessageFromHuman;
}
