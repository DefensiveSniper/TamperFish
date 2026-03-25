import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { postOutgoingMessage } from '../../services/outgoingApi';
import { useToast } from '../../hooks/useToast';
import { useAppDispatch } from '../../context/AppContext';
import { getSessionMessages } from '../../services/sessionsApi';
import { getOutgoingMessages } from '../../services/outgoingApi';
import { getOrders } from '../../services/ordersApi';
import type { ChatSnapshot, Message, Session } from '../../types/api';

interface ReplyBarProps {
  chatKey: string;
  session: Session;
  replyingMessage: Message | null;
  onCancelReply: () => void;
}

/**
 * 生成引用预览文案，避免把整条原始消息塞进输入区。
 * @param message - 当前选中的引用目标。
 * @returns 简短预览文案。
 */
function buildReplyPreview(message: Message | null): string {
  if (!message) {
    return '';
  }

  if (message.type === 'image') {
    return '[图片]';
  }

  const normalized = message.content.trim();
  return normalized.length > 36 ? `${normalized.slice(0, 36)}...` : normalized;
}

/**
 * 将用户选择的图片读成 data URL，供后端入队并由扩展 sender 还原成 File。
 * @param file - 用户在前端挑选的图片文件。
 * @returns 图片 data URL。
 */
function readImageAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }
      reject(new Error('无法读取图片数据'));
    };
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

export default function ReplyBar({
  chatKey,
  session,
  replyingMessage,
  onCancelReply,
}: ReplyBarProps) {
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [selectedImageData, setSelectedImageData] = useState<string | null>(null);
  const [selectedImageName, setSelectedImageName] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const dispatch = useAppDispatch();

  useEffect(() => {
    if (!replyingMessage || !selectedImageData) {
      return;
    }

    setSelectedImageData(null);
    setSelectedImageName(null);
  }, [replyingMessage, selectedImageData]);

  const refreshChatSnapshot = async () => {
    try {
      const [{ session: s, messages }, outgoing, linkedOrders] = await Promise.all([
        getSessionMessages(chatKey),
        getOutgoingMessages(chatKey),
        getOrders({ chatKey, limit: 10 }),
      ]);
      const snapshot: ChatSnapshot = { session: s, messages, outgoing, linkedOrders };
      dispatch({ type: 'SET_CHAT_CACHE', chatKey, snapshot });
    } catch {
      // non-critical
    }
  };

  const handlePickImage = () => {
    if (sending) return;
    fileInputRef.current?.click();
  };

  const handleImageChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast('只能选择图片文件', 'error');
      return;
    }
    if (file.size > 3 * 1024 * 1024) {
      toast('图片必须小于 3MB', 'error');
      return;
    }

    try {
      const mediaData = await readImageAsDataUrl(file);
      setSelectedImageData(mediaData);
      setSelectedImageName(file.name);
      setContent('');
      onCancelReply();
    } catch (error: unknown) {
      toast((error as Error).message, 'error');
    }
  };

  const clearSelectedImage = () => {
    setSelectedImageData(null);
    setSelectedImageName(null);
  };

  const handleSend = async () => {
    const trimmed = content.trim();
    const hasReply = Boolean(replyingMessage);
    const hasImage = Boolean(selectedImageData);
    if (sending) return;
    if (!trimmed && !hasImage) return;

    if (hasReply && !replyingMessage?.external_message_id) {
      toast('这条消息还没有同步到引用回复能力，请稍后重试', 'error');
      return;
    }

    setSending(true);
    try {
      const r = await postOutgoingMessage(
        hasImage
          ? {
            chatKey,
            sessionId: session.session_id || undefined,
            messageType: 'image',
            mediaData: selectedImageData || undefined,
            mediaName: selectedImageName || undefined,
            source: 'manual',
          }
          : {
            chatKey,
            sessionId: session.session_id || undefined,
            content: trimmed,
            messageType: 'text',
            replyToExternalMessageId: replyingMessage?.external_message_id || undefined,
            replyToPreview: buildReplyPreview(replyingMessage) || undefined,
            replyToType: replyingMessage?.type,
            source: 'manual',
          }
      );
      if (r.ok) {
        setContent('');
        clearSelectedImage();
        onCancelReply();
        toast(
          `${r.messageType === 'image' ? '图片' : '人工回复'}已入队 #${r.id}`,
          'success'
        );
        await refreshChatSnapshot();
      } else {
        toast('入队失败', 'error');
      }
    } catch (e: unknown) {
      toast((e as Error).message, 'error');
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div id="outbox-bar">
      <div className="outbox-meta">
        <div className="outbox-title">人工回复</div>
        <div className="outbox-subtitle">
          文本支持引用回复，图片会先入队再由扩展原生发送
        </div>
      </div>
      <div className="outbox-editor">
        {replyingMessage ? (
          <div className="outbox-chip reply">
            <div className="outbox-chip-label">引用回复</div>
            <div className="outbox-chip-value">{buildReplyPreview(replyingMessage)}</div>
            <button type="button" className="outbox-chip-close" onClick={onCancelReply}>
              取消
            </button>
          </div>
        ) : null}
        {selectedImageData ? (
          <div className="outbox-chip image">
            <div className="outbox-chip-label">图片待发送</div>
            <div className="outbox-chip-value">{selectedImageName || '未命名图片'}</div>
            <button type="button" className="outbox-chip-close" onClick={clearSelectedImage}>
              移除
            </button>
          </div>
        ) : null}
        <div className="outbox-input-row">
          <input
            id="ob-input"
            ref={inputRef}
            type="text"
            placeholder={selectedImageData ? '当前将发送图片，不能同时附带文本' : '输入人工回复内容，提交后进入 pending 队列...'}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={sending || Boolean(selectedImageData)}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="outbox-file-input"
            onChange={handleImageChange}
          />
          <button
            type="button"
            className="outbox-media-btn"
            onClick={handlePickImage}
            disabled={sending}
          >
            图片
          </button>
          <button
            id="ob-send"
            onClick={handleSend}
            disabled={sending}
          >
            {sending ? '发送中...' : '发送 ↗'}
          </button>
        </div>
      </div>
    </div>
  );
}
