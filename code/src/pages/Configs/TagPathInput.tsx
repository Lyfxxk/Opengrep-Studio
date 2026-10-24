import { useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';

const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 200;

interface TagPathInputProps {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
}

export default function TagPathInput({
  value,
  onChange,
  placeholder,
}: TagPathInputProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');

  const addDraft = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setError('');
      return;
    }
    if (trimmed.length > MAX_TAG_LENGTH) {
      setError(`单条路径不超过 ${MAX_TAG_LENGTH} 字符`);
      return;
    }
    if (value.length >= MAX_TAGS) {
      setError(`最多添加 ${MAX_TAGS} 条`);
      return;
    }
    if (value.includes(trimmed)) {
      setError('该路径已存在');
      return;
    }
    onChange([...value, trimmed]);
    setDraft('');
    setError('');
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addDraft();
    }
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    setDraft(event.target.value);
    setError('');
  };

  return (
    <div className="space-y-2">
      <Input
        value={draft}
        placeholder={placeholder}
        disabled={value.length >= MAX_TAGS}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={addDraft}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((item) => (
            <Badge key={item} variant="secondary" className="gap-1 py-1 font-normal">
              <span className="font-mono text-xs">{item}</span>
              <button
                type="button"
                aria-label={`删除 ${item}`}
                className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onChange(value.filter((tag) => tag !== item))}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        输入后回车添加，最多 {MAX_TAGS} 条
      </p>
    </div>
  );
}
