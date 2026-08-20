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
let adminToken: string;
let patientToken: string;
let doctorToken: string;

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

type DoctorResponse = {
  id: string;
  specialization: string;
  slotDuration: number;
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    passwordHash?: string;
  };
  passwordHash?: string;
};

type AvailabilityResponse = {
  id: string;
  weekday: string;
  startTime: string;
  endTime: string;
  passwordHash?: string;
};

type LeaveResponse = {
  id: string;
  date: string;
  reason?: string;
  passwordHash?: string;
};

function makeEmail(prefix: string) {
  const email = `${prefix}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}@example.com`;
  testEmails.add(email);
  return email;
}

function containsPasswordHash(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsPasswordHash);
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  return Object.entries(value).some(
    ([key, childValue]) => key === "passwordHash" || containsPasswordHash(childValue)
  );
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

  if (response.status === 204) {
    return {
      status: response.status,
      body: null
    };
  }

  return {
    status: response.status,
    body: await response.json()
  };
}

async function login(email: string, password = "Password123!") {
  const response = await requestJson("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });

  assert.equal(response.status, 200);

  return response.body as LoginResult;
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`
  };
}

async function createDoctor(
  token: string,
  overrides: Partial<{
    name: string;
    email: string;
    password: string;
    specialization: string;
    slotDuration: number;
  }> = {}
) {
  const email = overrides.email ?? makeEmail("admin.doctor");

  return requestJson("/api/admin/doctors", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      name: "Dr. Test Admin",
      password: "Password123!",
      specialization: "Neurology",
      slotDuration: 30,
      ...overrides,
      email,
    })
  });
}

async function createDoctorForTest() {
  const response = await createDoctor(adminToken);
  assert.equal(response.status, 201);

  return (response.body as { doctor: DoctorResponse }).doctor;
}

before(async () => {
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  adminToken = (await login("admin@example.com")).token;
  patientToken = (await login("patient@example.com")).token;
  doctorToken = (await login("maya.patel@example.com")).token;
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

describe("admin doctor management", () => {
  test("unauthenticated admin route returns 401", async () => {
    const response = await requestJson("/api/admin/doctors");

    assert.equal(response.status, 401);
  });

  test("patient admin route returns 403", async () => {
    const response = await requestJson("/api/admin/doctors", {
      headers: authHeaders(patientToken)
    });

    assert.equal(response.status, 403);
  });

  test("doctor admin route returns 403", async () => {
    const response = await requestJson("/api/admin/doctors", {
      headers: authHeaders(doctorToken)
    });

    assert.equal(response.status, 403);
  });

  test("admin can create doctor", async () => {
    const email = makeEmail("admin.create");
    const response = await createDoctor(adminToken, {
      email,
      name: "Dr. Create Test",
      specialization: "Endocrinology",
      slotDuration: 45
    });

    assert.equal(response.status, 201);

    const body = response.body as { doctor: DoctorResponse };
    assert.equal(body.doctor.user.email, email);
    assert.equal(body.doctor.user.name, "Dr. Create Test");
    assert.equal(body.doctor.specialization, "Endocrinology");
    assert.equal(body.doctor.slotDuration, 45);
  });

  test("created user has DOCTOR role", async () => {
    const email = makeEmail("admin.role");
    const response = await createDoctor(adminToken, { email });
    assert.equal(response.status, 201);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { role: true }
    });

    assert.equal(user.role, "DOCTOR");
  });

  test("duplicate doctor email is rejected", async () => {
    const email = makeEmail("admin.duplicate");
    const firstResponse = await createDoctor(adminToken, { email });
    const duplicateResponse = await createDoctor(adminToken, { email });

    assert.equal(firstResponse.status, 201);
    assert.equal(duplicateResponse.status, 409);
  });

  test("admin can update specialization", async () => {
    const doctor = await createDoctorForTest();
    const response = await requestJson(`/api/admin/doctors/${doctor.id}`, {
      method: "PATCH",
      headers: authHeaders(adminToken),
      body: JSON.stringify({
        specialization: "Pulmonology"
      })
    });

    assert.equal(response.status, 200);

    const body = response.body as { doctor: DoctorResponse };
    assert.equal(body.doctor.specialization, "Pulmonology");
    assert.equal(body.doctor.user.role, "DOCTOR");
  });

  test("invalid slot duration is rejected", async () => {
    const response = await createDoctor(adminToken, {
      email: makeEmail("admin.invalid.duration"),
      slotDuration: 0
    });

    assert.equal(response.status, 400);
  });

  test("admin can add availability", async () => {
    const doctor = await createDoctorForTest();
    const response = await requestJson(
      `/api/admin/doctors/${doctor.id}/availability`,
      {
        method: "POST",
        headers: authHeaders(adminToken),
        body: JSON.stringify({
          weekday: "MONDAY",
          startTime: "09:00",
          endTime: "12:00"
        })
      }
    );

    assert.equal(response.status, 201);

    const body = response.body as { availability: AvailabilityResponse };
    assert.equal(body.availability.weekday, "MONDAY");
    assert.equal(body.availability.startTime, "09:00");
    assert.equal(body.availability.endTime, "12:00");
  });

  test("duplicate availability is rejected", async () => {
    const doctor = await createDoctorForTest();
    const payload = {
      weekday: "TUESDAY",
      startTime: "10:00",
      endTime: "13:00"
    };

    const firstResponse = await requestJson(
      `/api/admin/doctors/${doctor.id}/availability`,
      {
        method: "POST",
        headers: authHeaders(adminToken),
        body: JSON.stringify(payload)
      }
    );
    const duplicateResponse = await requestJson(
      `/api/admin/doctors/${doctor.id}/availability`,
      {
        method: "POST",
        headers: authHeaders(adminToken),
        body: JSON.stringify(payload)
      }
    );

    assert.equal(firstResponse.status, 201);
    assert.equal(duplicateResponse.status, 409);
  });

  test("invalid availability range is rejected", async () => {
    const doctor = await createDoctorForTest();
    const response = await requestJson(
      `/api/admin/doctors/${doctor.id}/availability`,
      {
        method: "POST",
        headers: authHeaders(adminToken),
        body: JSON.stringify({
          weekday: "WEDNESDAY",
          startTime: "15:00",
          endTime: "09:00"
        })
      }
    );

    assert.equal(response.status, 400);
  });

  test("admin can add leave", async () => {
    const doctor = await createDoctorForTest();
    const response = await requestJson(`/api/admin/doctors/${doctor.id}/leave`, {
      method: "POST",
      headers: authHeaders(adminToken),
      body: JSON.stringify({
        date: "2026-09-15",
        reason: "Conference"
      })
    });

    assert.equal(response.status, 201);

    const body = response.body as { leave: LeaveResponse };
    assert.ok(body.leave.id);
    assert.equal(body.leave.reason, "Conference");
  });

  test("duplicate leave is rejected", async () => {
    const doctor = await createDoctorForTest();
    const payload = {
      date: "2026-09-16",
      reason: "Training"
    };

    const firstResponse = await requestJson(`/api/admin/doctors/${doctor.id}/leave`, {
      method: "POST",
      headers: authHeaders(adminToken),
      body: JSON.stringify(payload)
    });
    const duplicateResponse = await requestJson(
      `/api/admin/doctors/${doctor.id}/leave`,
      {
        method: "POST",
        headers: authHeaders(adminToken),
        body: JSON.stringify(payload)
      }
    );

    assert.equal(firstResponse.status, 201);
    assert.equal(duplicateResponse.status, 409);
  });

  test("admin can remove leave", async () => {
    const doctor = await createDoctorForTest();
    const createResponse = await requestJson(
      `/api/admin/doctors/${doctor.id}/leave`,
      {
        method: "POST",
        headers: authHeaders(adminToken),
        body: JSON.stringify({
          date: "2026-09-17",
          reason: "Personal"
        })
      }
    );
    assert.equal(createResponse.status, 201);

    const leave = (createResponse.body as { leave: LeaveResponse }).leave;
    const deleteResponse = await requestJson(
      `/api/admin/doctors/${doctor.id}/leave/${leave.id}`,
      {
        method: "DELETE",
        headers: authHeaders(adminToken)
      }
    );

    assert.equal(deleteResponse.status, 204);

    const remainingLeaves = await prisma.doctorLeave.count({
      where: { id: leave.id }
    });
    assert.equal(remainingLeaves, 0);
  });

  test("API responses do not expose passwordHash", async () => {
    const doctor = await createDoctorForTest();
    const [listResponse, detailResponse, updateResponse] = await Promise.all([
      requestJson("/api/admin/doctors", {
        headers: authHeaders(adminToken)
      }),
      requestJson(`/api/admin/doctors/${doctor.id}`, {
        headers: authHeaders(adminToken)
      }),
      requestJson(`/api/admin/doctors/${doctor.id}`, {
        method: "PATCH",
        headers: authHeaders(adminToken),
        body: JSON.stringify({ name: "Dr. Safe Response" })
      })
    ]);

    assert.equal(listResponse.status, 200);
    assert.equal(detailResponse.status, 200);
    assert.equal(updateResponse.status, 200);
    assert.equal(containsPasswordHash(listResponse.body), false);
    assert.equal(containsPasswordHash(detailResponse.body), false);
    assert.equal(containsPasswordHash(updateResponse.body), false);
  });
});
