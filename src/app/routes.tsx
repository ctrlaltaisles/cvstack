import { createBrowserRouter } from "react-router";
import LandingPage from "./pages/LandingPage";
import MethodSelection from "./pages/MethodSelection";
import Workspace from "./pages/Workspace";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: LandingPage,
  },
  {
    path: "/start",
    Component: MethodSelection,
  },
  {
    path: "/workspace",
    Component: Workspace,
  },
]);
