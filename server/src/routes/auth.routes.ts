import { Router } from "express";

import {
  loginUser,
  me,
  register
} from "../controllers/auth.controller.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { authenticate } from "../middleware/authenticate.js";

export const authRouter = Router();

authRouter.post("/register", asyncHandler(register));
authRouter.post("/login", asyncHandler(loginUser));
authRouter.get("/me", authenticate, asyncHandler(me));
