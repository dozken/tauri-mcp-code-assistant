import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/CreateNewFolder';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useAppStore } from '../store/appStore';
import { cancelIndexing, removeRoot } from '../api/http';
import { getAppInfo, pickFolder, type AppInfo } from '../api/tauri';
import { MONOSPACE } from '../theme';

export interface SidebarProps {
  onIndexFolder: (path: string) => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
}

const basename = (path: string): string => path.split(/[\\/]/).findLast(Boolean) ?? path;

export const Sidebar = ({ onIndexFolder, onRefresh }: SidebarProps) => {
  const roots = useAppStore((state) => state.roots);
  const activeJob = useAppStore((state) => state.activeJob);
  const selectedRoot = useAppStore((state) => state.selectedRoot);
  const selectRoot = useAppStore((state) => state.selectRoot);
  const setError = useAppStore((state) => state.setError);

  const [manualOpen, setManualOpen] = useState(false);
  const [manualPath, setManualPath] = useState('');
  const [appInfo, setAppInfo] = useState<AppInfo>();

  useEffect(() => {
    // Resolves to undefined in the browser build, which hides the footer.
    void getAppInfo()
      .then(setAppInfo)
      .catch(() => undefined);
  }, []);

  const handleAdd = async (): Promise<void> => {
    const picked = await pickFolder();
    // `undefined` means there is no native dialog (browser mode), `null` means cancelled.
    if (picked === undefined) {
      setManualOpen(true);
      return;
    }
    if (picked) await onIndexFolder(picked);
  };

  const closeManual = (): void => {
    setManualOpen(false);
    setManualPath('');
  };

  const submitManual = async (): Promise<void> => {
    const path = manualPath.trim();
    closeManual();
    if (path) await onIndexFolder(path);
  };

  const handleCancel = (): void => {
    void cancelIndexing().catch((error: unknown) => {
      setError(error instanceof Error ? error.message : String(error));
    });
  };

  const handleRemove = async (path: string): Promise<void> => {
    try {
      await removeRoot(path);
      await onRefresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Stack sx={{ height: '100%' }}>
      <Box sx={{ p: 2, pb: 1 }}>
        <Typography variant="overline" color="text.secondary">
          Indexed folders
        </Typography>
        <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
          <Button
            fullWidth
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => void handleAdd()}
            disabled={activeJob !== null}
            data-testid="add-folder"
          >
            Add folder
          </Button>
          <Tooltip title="Refresh status">
            <span>
              <IconButton onClick={() => void onRefresh()} aria-label="Refresh status">
                <RefreshIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      </Box>

      {activeJob ? (
        <Box sx={{ px: 2, pb: 1 }} data-testid="index-progress">
          <Typography variant="caption" color="text.secondary" noWrap>
            Indexing {basename(activeJob.root)} — {activeJob.filesIndexed}/
            {activeJob.filesDiscovered} files, {activeJob.chunksIndexed} chunks
          </Typography>
          <LinearProgress
            variant={activeJob.filesDiscovered > 0 ? 'determinate' : 'indeterminate'}
            value={activeJob.percent}
            sx={{ mt: 0.5 }}
          />
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 0.5 }}>
            {activeJob.currentFile ? (
              <Typography
                variant="caption"
                sx={{ fontFamily: MONOSPACE, flex: 1, minWidth: 0 }}
                noWrap
              >
                {activeJob.currentFile}
              </Typography>
            ) : (
              <Box sx={{ flex: 1 }} />
            )}
            <Button size="small" color="inherit" onClick={handleCancel} data-testid="cancel-index">
              Cancel
            </Button>
          </Stack>
        </Box>
      ) : null}

      <Divider />

      <List dense sx={{ flex: 1, overflowY: 'auto', py: 0 }} data-testid="root-list">
        {roots.length === 0 && (
          <ListItem>
            <ListItemText
              primary="No folders yet"
              secondary="Add a folder to index it and start asking questions."
              slotProps={{ secondary: { variant: 'caption' } }}
            />
          </ListItem>
        )}

        {roots.map((root) => (
          <ListItem
            key={root.path}
            disablePadding
            secondaryAction={
              <IconButton
                edge="end"
                size="small"
                aria-label={`Remove ${root.path}`}
                onClick={() => void handleRemove(root.path)}
              >
                <DeleteIcon fontSize="small" />
              </IconButton>
            }
          >
            <ListItemButton
              selected={selectedRoot === root.path}
              // Clicking the selected folder clears the filter.
              onClick={() => selectRoot(selectedRoot === root.path ? undefined : root.path)}
            >
              <ListItemText
                primary={basename(root.path)}
                secondary={
                  <>
                    <Typography
                      variant="caption"
                      sx={{ fontFamily: MONOSPACE }}
                      noWrap
                      display="block"
                    >
                      {root.path}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {root.fileCount} files · {root.chunkCount} chunks
                    </Typography>
                    {root.stale ? (
                      <Chip
                        size="small"
                        color="warning"
                        variant="outlined"
                        label="needs re-index"
                        sx={{ ml: 1, height: 18 }}
                      />
                    ) : null}
                  </>
                }
                slotProps={{ secondary: { component: 'span' } }}
              />
            </ListItemButton>
          </ListItem>
        ))}
      </List>

      {appInfo ? (
        <>
          <Divider />
          <Box sx={{ px: 2, py: 1 }}>
            <Typography variant="caption" color="text.secondary">
              v{appInfo.version} · {appInfo.platform} · {appInfo.backendUrl}
            </Typography>
          </Box>
        </>
      ) : null}

      <Dialog open={manualOpen} onClose={closeManual} fullWidth maxWidth="sm">
        <DialogTitle>Index a folder</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            The native folder picker is only available in the Tauri app. Paste an absolute path
            instead.
          </Typography>
          <TextField
            // A modal's first field is the documented exception to no-autofocus:
            // focus has to move into the dialog for keyboard users.
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            fullWidth
            margin="dense"
            label="Absolute path"
            placeholder="/Users/you/projects/my-app"
            value={manualPath}
            onChange={(event) => setManualPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submitManual();
            }}
            slotProps={{ htmlInput: { 'data-testid': 'manual-path' } }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeManual}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => void submitManual()}
            data-testid="manual-path-submit"
          >
            Index
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
};
