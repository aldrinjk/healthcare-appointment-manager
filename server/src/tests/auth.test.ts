import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

process.env.NODE_ENV = "test";

const [{ app }, { prisma }] = await Promise.all([
  import("../app.js"),
  import("../utils/prisma.js")
]);

const testEmails = new Set<string>();
let server: Server;
let baseUrl: string;

type JsonResponse = {
  status: number;
  body: unknown;
};

type LoginResult = {
  token: string;
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    passwordHash?: string;
  };
};

function makeEmail(prefix: string) {
  const email = `${prefix}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}@example.com`;
  testEmails.add(email);
  return email;
}

async function requestJson(
  path: string,
  options: RequestInit = {}
): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options.headers
    }
  });

  const body = await response.json();

  return {
    status: response.status,
    body
  };
}

async function registerPatient(email: string, extraBody: Record<string, unknown> = {}) {
  return requestJson("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      name: "Test Patient",
      email,
      password: "Password123!",
      ...extraBody
    })
  });
}

async function login(email: string, password = "Password123!") {
  const response = await requestJson("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });

  assert.equal(response.status, 200);

  return response.body as LoginResult;
}

async function getWithToken(path: string, token?: string) {
  return requestJson(path, {
    method: "GET",
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
}

before(async () => {
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await prisma.user.deleteMany({
    where: {
      email: {
        in: [...testEmails]
      }
    }
  });

  await prisma.$disconnect();

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
});

describe("authentication and RBAC", () => {
  test("patient registration succeeds with safe user data", async () => {
    const email = makeEmail("register.success");
    const response = await registerPatient(`  ${email.toUpperCase()}  `);

    assert.equal(response.status, 201);

    const body = response.body as { user: Record<string, unknown> };
    assert.equal(body.user.email, email);
    assert.equal(body.user.role, "PATIENT");
    assert.equal(body.user.passwordHash, undefined);
  });

  test("duplicate registration is rejected cleanly", async () => {
    const email = makeEmail("register.duplicate");
    const firstResponse = await registerPatient(email);
    const duplicateResponse = await registerPatient(email);

    assert.equal(firstResponse.status, 201);
    assert.equal(duplicateResponse.status, 409);
  });

  test("public registration cannot create admin or doctor users", async () => {
    const adminEmail = makeEmail("register.admin");
    const doctorEmail = makeEmail("register.doctor");

    const adminResponse = await registerPatient(adminEmail, { role: "ADMIN" });
    const doctorResponse = await registerPatient(doctorEmail, { role: "DOCTOR" });

    assert.equal(adminResponse.status, 400);
    assert.equal(doctorResponse.status, 400);

    const createdUsers = await prisma.user.count({
      where: {
        email: {
          in: [adminEmail, doctorEmail]
        }
      }
    });

    assert.equal(createdUsers, 0);
  });

  test("login succeeds and returns token plus safe user data", async () => {
    const result = await login("patient@example.com");

    assert.equal(typeof result.token, "string");
    assert.ok(result.token.length > 20);
    assert.equal(result.user.email, "patient@example.com");
    assert.equal(result.user.role, "PATIENT");
    assert.equal(result.user.passwordHash, undefined);
  });

  test("login failure for wrong password does not reveal which field was wrong", async () => {
    const response = await requestJson("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: "patient@example.com",
        password: "wrong-password"
      })
    });

    assert.equal(response.status, 401);
    assert.deepEqual(response.body, {
      error: {
        code: "INVALID_CREDENTIALS",
        message: "Invalid email or password"
      }
    });
  });

  test("protected endpoint rejects missing token", async () => {
    const response = await getWithToken("/api/test/rbac/protected");

    assert.equal(response.status, 401);
  });

  test("invalid token is rejected", async () => {
    const response = await getWithToken("/api/test/rbac/protected", "not-a-valid-token");

    assert.equal(response.status, 401);
  });

  test("patient role is blocked from admin route", async () => {
    const { token } = await login("patient@example.com");
    const response = await getWithToken("/api/test/rbac/admin", token);

    assert.equal(response.status, 403);
  });

  test("patient role is blocked from doctor route", async () => {
    const { token } = await login("patient@example.com");
    const response = await getWithToken("/api/test/rbac/doctor", token);

    assert.equal(response.status, 403);
  });

  test("doctor role is blocked from admin route", async () => {
    const { token } = await login("maya.patel@example.com");
    const response = await getWithToken("/api/test/rbac/admin", token);

    assert.equal(response.status, 403);
  });

  test("admin role is allowed on admin route", async () => {
    const { token } = await login("admin@example.com");
    const response = await getWithToken("/api/test/rbac/admin", token);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { status: "ok" });
  });

  test("GET /api/auth/me returns correct safe user data", async () => {
    const { token, user } = await login("patient@example.com");
    const response = await getWithToken("/api/auth/me", token);

    assert.equal(response.status, 200);

    const body = response.body as { user: Record<string, unknown> };
    assert.equal(body.user.id, user.id);
    assert.equal(body.user.email, "patient@example.com");
    assert.equal(body.user.role, "PATIENT");
    assert.equal(body.user.passwordHash, undefined);
  });
});
