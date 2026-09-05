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

const SIDEBAR_WIDTH = 300;

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

  return (
    <Box sx={{ display: 'flex', height: '100vh' }}>
      <AppBar
        position="fixed"
        color="transparent"
        elevation={0}
        sx={{
          // Above a permanent drawer, below a temporary one. With the overlay
          // drawer the scrim must cover the whole app: at drawer+1 the bar was
          // half bright and half dimmed, and its chips sat at 1.2:1 through the
          // scrim.
          zIndex: (theme) => (compact ? theme.zIndex.appBar : theme.zIndex.drawer + 1),
          backdropFilter: 'blur(8px)',
        }}
      >
        <Toolbar variant="dense" sx={{ borderBottom: 1, borderColor: 'divider' }}>
          {compact ? (
            <IconButton
              edge="start"
              size="small"
              aria-label="Show indexed folders"
              onClick={() => {
                setDrawerOpen(true);
              }}
              sx={{ mr: 1 }}
            >
              <MenuIcon fontSize="small" />
            </IconButton>
          ) : null}
          <Typography variant="subtitle1" sx={{ fontWeight: 600, flexGrow: 1 }} noWrap>
            AI Code Companion
          </Typography>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Tooltip
              title={
                vectorStore === 'chroma'
                  ? 'Chunks are persisted in ChromaDB'
                  : 'Chroma is unreachable — using the in-memory store, which is lost on restart'
              }
            >
              <Chip
                size="small"
                variant="outlined"
                color={vectorStore === 'chroma' ? 'secondary' : 'default'}
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
        sx={{
          width: compact ? 0 : SIDEBAR_WIDTH,
          flexShrink: 0,
          [`& .MuiDrawer-paper`]: { width: SIDEBAR_WIDTH, boxSizing: 'border-box' },
        }}
      >
        {/* Spacer only under a permanent drawer; the overlay covers the bar. */}
        {compact ? null : <Toolbar variant="dense" />}
        <Sidebar onIndexFolder={indexFolder} onRefresh={refreshStatus} />
      </Drawer>

      <Box
        component="main"
        sx={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}
      >
        <Toolbar variant="dense" />
        <Box sx={{ flex: 1, minHeight: 0 }}>
          <ChatPanel onSend={sendMessage} />
        </Box>
      </Box>
    </Box>
  );
};
