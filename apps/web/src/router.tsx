import { createBrowserRouter } from "react-router";
import { LoginPage } from "./pages/LoginPage";
import { NoteListPage } from "./pages/NoteListPage";
import { NoteDetailPage } from "./pages/NoteDetailPage";
import { NoteEditPage } from "./pages/NoteEditPage";
import { SaveNotePage } from "./pages/SaveNotePage";
import { RequireAuth } from "./components/RequireAuth";
import { AppLayout } from "./components/AppLayout";

export const router = createBrowserRouter([
  {
    path: "/login",
    element: <LoginPage />,
  },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          {
            path: "/",
            element: <NoteListPage />,
          },
          {
            path: "/save",
            element: <SaveNotePage />,
          },
          {
            path: "/notes/:id",
            element: <NoteDetailPage />,
          },
          {
            path: "/notes/:id/edit",
            element: <NoteEditPage />,
          },
        ],
      },
    ],
  },
]);
