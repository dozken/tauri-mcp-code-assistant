import { useState } from 'react';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import MenuIcon from '@mui/icons-material/Menu';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { useAppStore } from './store/appStore';
import { useBackend } from './hooks/useBackend';
import { ChatPanel } from './components/ChatPanel';
import { Sidebar } from './components/Sidebar';
import * as styles from './App.styles';

export const App = () => {
  const theme = useTheme();
  // A desktop window can be dragged to any width. Below this the permanent
  // 300px drawer takes more than a third of the window and the transcript stops
  // being readable, so it becomes an overlay the user opens on demand.
  const compact = useMediaQuery(theme.breakpoints.down('md'));
  const [drawerOpen, setDrawerOpen] = useState(false);

  const { sendMessage, indexFolder, refreshStatus } = useBackend();
  const connected = useAppStore((state) => state.connected);
  const vectorStore = useAppStore((state) => state.vectorStore);
  const totalChunks = useAppStore((state) => state.totalChunks);
  // One source of truth: the tooltip and the chip colour say the same thing, and
  // splitting the condition let them drift apart without a test noticing.
  // Any store but the in-memory one keeps its chunks across a restart. Naming
  // `chroma` here stopped being right the moment a plugin could add a third.
  const persisted = vectorStore !== 'memory';

  return (
    <Box sx={styles.shell}>
      <AppBar position="fixed" color="transparent" elevation={0} sx={styles.appBar(compact)}>
        <Toolbar variant="dense" sx={styles.toolbar}>
          {compact ? (
            <IconButton
              edge="start"
              size="small"
              aria-label="Show indexed folders"
              onClick={() => {
                setDrawerOpen(true);
              }}
              sx={styles.menuButton}
            >
              <MenuIcon fontSize="small" />
            </IconButton>
          ) : null}
          <Typography variant="subtitle1" sx={styles.title} noWrap>
            AI Code Companion
          </Typography>
          <Stack direction="row" spacing={1} sx={styles.statusChips}>
            <Tooltip
              title={
                persisted
                  ? `Chunks are persisted in ${vectorStore}`
                  : 'Chroma is unreachable — using the in-memory store, which is lost on restart'
              }
            >
              <Chip
                size="small"
                variant="outlined"
                color={persisted ? 'secondary' : 'default'}
                label={`${vectorStore} · ${totalChunks} chunks`}
              />
            </Tooltip>
            <Chip
              size="small"
              color={connected ? 'success' : 'error'}
              variant="outlined"
              label={connected ? 'connected' : 'offline'}
              data-testid="connection-status"
            />
          </Stack>
        </Toolbar>
      </AppBar>

      <Drawer
        variant={compact ? 'temporary' : 'permanent'}
        // The permanent variant ignores `open`, so this only ever drives the
        // overlay; a `compact ? … : true` ternary here reads as a rule and is not one.
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
        }}
        // Keeping the overlay drawer mounted preserves its scroll position and
        // keeps the folder list in the tree for tests at every width.
        ModalProps={{ keepMounted: true }}
        sx={styles.drawer(compact)}
      >
        {/* Spacer only under a permanent drawer; the overlay covers the bar. */}
        {compact ? null : <Toolbar variant="dense" />}
        <Sidebar onIndexFolder={indexFolder} onRefresh={refreshStatus} />
      </Drawer>

      <Box component="main" sx={styles.main}>
        <Toolbar variant="dense" />
        <Box sx={styles.chatArea}>
          <ChatPanel onSend={sendMessage} />
        </Box>
      </Box>
    </Box>
  );
};
