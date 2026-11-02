import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { IProject } from '@/data/projects';

export default function ListFilterBar({
  total,
  projects,
  projectId,
  onProjectChange,
  keyword,
  onKeywordChange,
  allLabel,
  placeholder,
  countLabel,
}: {
  total: number;
  projects: IProject[];
  projectId: string;
  onProjectChange: (projectId: string) => void;
  keyword: string;
  onKeywordChange: (keyword: string) => void;
  allLabel: string;
  placeholder: string;
  countLabel: string;
}) {
  if (total === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={projectId} onValueChange={onProjectChange}>
        <SelectTrigger className="w-[200px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{allLabel}</SelectItem>
          {projects.map((project) => (
            <SelectItem key={project.id} value={project.id}>
              {project.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="relative min-w-[180px] flex-1 sm:max-w-[280px]">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={keyword}
          onChange={(event) => onKeywordChange(event.target.value)}
          placeholder={placeholder}
          className="pl-9"
        />
      </div>
      <span className="text-xs text-muted-foreground">{countLabel}</span>
    </div>
  );
}
