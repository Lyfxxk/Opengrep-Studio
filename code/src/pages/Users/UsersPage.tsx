import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { KeyRound, Plus, Trash2, Users } from 'lucide-react';
import { formatDateTime } from '@/lib/format';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getCurrentUser } from '@/lib/auth';
import { usersApi, type IUserRecord, type UserRole } from '@/lib/api';

const USERNAME_PATTERN = /^[A-Za-z0-9_-]+$/;

const ROLES: UserRole[] = ['admin', 'auditor', 'viewer'];

const ROLE_LABEL_KEY: Record<UserRole, 'users.roleAdmin' | 'users.roleAuditor' | 'users.roleViewer'> = {
  admin: 'users.roleAdmin',
  auditor: 'users.roleAuditor',
  viewer: 'users.roleViewer',
};

export default function UsersPage() {
  const { t } = useTranslation();
  const currentUser = getCurrentUser();
  const [users, setUsers] = useState<IUserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<IUserRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IUserRecord | null>(null);

  const refresh = useCallback(async () => {
    try {
      setUsers(await usersApi.list());
    } catch (error) {
      toast.error(t('users.loadFailed', { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void Promise.resolve().then(() => void refresh());
  }, [refresh]);

  const handleRoleChange = async (user: IUserRecord, role: UserRole) => {
    if (role === user.role) return;
    try {
      await usersApi.updateRole(user.id, role);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await usersApi.remove(deleteTarget.id);
      setDeleteTarget(null);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const roleLabel = (role: UserRole) => t(ROLE_LABEL_KEY[role]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">{t('users.title')}</h1>
        <Button data-testid="user-create-open" className="gap-1" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          {t('users.newUser')}
        </Button>
      </div>

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          {loading ? (
            <div className="space-y-3 px-6 py-8">
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={index} className="h-10 w-full" />
              ))}
            </div>
          ) : users.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
              <Users className="size-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t('users.empty')}</p>
            </div>
          ) : (
            <div className="w-full overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="whitespace-nowrap">{t('users.colUsername')}</TableHead>
                    <TableHead className="whitespace-nowrap">{t('users.colRole')}</TableHead>
                    <TableHead className="whitespace-nowrap">{t('users.colCreatedAt')}</TableHead>
                    <TableHead className="whitespace-nowrap text-right">{t('common.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((user) => {
                    const isInitialAdmin = user.username === 'admin';
                    const isSelf = user.username === currentUser?.username;
                    return (
                      <TableRow key={user.id}>
                        <TableCell>
                          <span className="flex items-center gap-1.5 font-medium">
                            {user.username}
                            {isSelf && (
                              <Badge variant="outline" className="px-1.5 py-0 text-[11px] font-normal">
                                {t('users.selfBadge')}
                              </Badge>
                            )}
                          </span>
                        </TableCell>
                        <TableCell>
                          {isInitialAdmin ? (
                            <Badge variant="secondary" className="font-normal">
                              {roleLabel(user.role)}
                            </Badge>
                          ) : (
                            <Select
                              value={user.role}
                              disabled={isSelf}
                              onValueChange={(value) => void handleRoleChange(user, value as UserRole)}
                            >
                              <SelectTrigger
                                className="h-8 w-32"
                                aria-label={t('users.roleSelectAria', { name: user.username })}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {ROLES.map((role) => (
                                  <SelectItem key={role} value={role}>
                                    {roleLabel(role)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                          {formatDateTime(user.createdAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              title={t('users.resetAction')}
                              onClick={() => setResetTarget(user)}
                            >
                              <KeyRound className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 text-destructive hover:text-destructive"
                              title={t('common.delete')}
                              disabled={isInitialAdmin || isSelf}
                              onClick={() => setDeleteTarget(user)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <CreateUserDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => void refresh()}
      />

      <ResetPasswordDialog
        target={resetTarget}
        onOpenChange={(open) => {
          if (!open) setResetTarget(null);
        }}
        onSaved={() => void refresh()}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('users.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('users.deleteDesc', { name: deleteTarget?.username ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>{t('common.confirmDelete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CreateUserDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('viewer');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [prevCreateOpen, setPrevCreateOpen] = useState(open);
  if (prevCreateOpen !== open) {
    setPrevCreateOpen(open);
    if (open) {
      setUsername('');
      setPassword('');
      setRole('viewer');
      setError('');
      setSubmitting(false);
    }
  }

  const handleSubmit = async () => {
    if (submitting) return;
    const trimmed = username.trim();
    if (!trimmed || trimmed.length > 50 || !USERNAME_PATTERN.test(trimmed)) {
      setError(t('users.errorUsername'));
      return;
    }
    if (password.length < 6 || password.length > 100) {
      setError(t('users.errorPassword'));
      return;
    }
    setSubmitting(true);
    try {
      await usersApi.create({ username: trimmed, password, role });
      onOpenChange(false);
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('users.createUserTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="user-username">{t('users.usernameLabel')}</Label>
            <Input
              id="user-username"
              value={username}
              maxLength={50}
              autoComplete="off"
              placeholder={t('users.usernamePlaceholder')}
              onChange={(event) => {
                setUsername(event.target.value);
                setError('');
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="user-password">{t('users.passwordLabel')}</Label>
            <Input
              id="user-password"
              type="password"
              value={password}
              maxLength={100}
              autoComplete="new-password"
              placeholder={t('users.passwordPlaceholder')}
              onChange={(event) => {
                setPassword(event.target.value);
                setError('');
              }}
            />
          </div>
          <div className="space-y-2">
            <Label>{t('users.roleLabel')}</Label>
            <Select value={role} onValueChange={(value) => setRole(value as UserRole)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(ROLE_LABEL_KEY[item])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button data-testid="user-create-submit" onClick={() => void handleSubmit()} disabled={submitting}>
            {t('users.createAction')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({
  target,
  onOpenChange,
  onSaved,
}: {
  target: IUserRecord | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [prevResetTarget, setPrevResetTarget] = useState(target);
  if (prevResetTarget !== target) {
    setPrevResetTarget(target);
    if (target) {
      setPassword('');
      setError('');
      setSubmitting(false);
    }
  }

  const handleSubmit = async () => {
    if (!target || submitting) return;
    if (password.length < 6 || password.length > 100) {
      setError(t('users.errorPassword'));
      return;
    }
    setSubmitting(true);
    try {
      await usersApi.resetPassword(target.id, password);
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AlertDialog open={target !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('users.resetTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('users.resetDesc', { name: target?.username ?? '' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor="user-new-password">{t('users.newPasswordLabel')}</Label>
          <Input
            id="user-new-password"
            type="password"
            value={password}
            maxLength={100}
            autoComplete="new-password"
            placeholder={t('users.passwordPlaceholder')}
            onChange={(event) => {
              setPassword(event.target.value);
              setError('');
            }}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              void handleSubmit();
            }}
            disabled={submitting}
          >
            {t('users.resetAction')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
