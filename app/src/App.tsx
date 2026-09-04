import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Drawer from '@mui/material/Drawer';
import Stack from '@mui/material/Stack';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useAppStore } from './store/appStore';
import { useBackend } from './hooks/useBackend';
import { ChatPanel } from './components/ChatPanel';
import { Sidebar } from './components/Sidebar';

const SIDEBAR_WIDTH = 300;

export const App = () => {
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
        sx={{ zIndex: (theme) => theme.zIndex.drawer + 1, backdropFilter: 'blur(8px)' }}
      >
        <Toolbar variant="dense" sx={{ borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="subtitle1" fontWeight={600} sx={{ flexGrow: 1 }}>
            AI Code Companion
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center">
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
        variant="permanent"
        sx={{
          width: SIDEBAR_WIDTH,
          flexShrink: 0,
          [`& .MuiDrawer-paper`]: { width: SIDEBAR_WIDTH, boxSizing: 'border-box' },
        }}
      >
        <Toolbar variant="dense" />
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
