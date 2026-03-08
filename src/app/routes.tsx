import { createBrowserRouter } from "react-router";
import LandingPage from "./pages/LandingPage";
import MethodSelection from "./pages/MethodSelection";
import Workspace from "./pages/Workspace";
import LoginPage from "./pages/LoginPage";
import SharedResumePage from "./pages/SharedResumePage";

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
  {
    path: "/login",
    Component: LoginPage,
  },
  {
    path: "/shared/:token",
    Component: SharedResumePage,
  },
  {
    path: "/:shareSlug",
    Component: SharedResumePage,
  },
]);
