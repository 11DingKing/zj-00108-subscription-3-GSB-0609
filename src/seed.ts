import "reflect-metadata";
import { AppDataSource } from "./data-source";
import { User, UserRole } from "./entities/User";
import { Plan, PlanType } from "./entities/Plan";
import { Subscription, SubscriptionStatus } from "./entities/Subscription";
import { Bill, BillStatus } from "./entities/Bill";
import * as fs from "fs";
import * as path from "path";

const seed = async () => {
  const dataDir = path.join(__dirname, "..", "data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  await AppDataSource.initialize();
  console.log("Database connected");

  const userRepository = AppDataSource.getRepository(User);
  const planRepository = AppDataSource.getRepository(Plan);
  const subscriptionRepository = AppDataSource.getRepository(Subscription);
  const billRepository = AppDataSource.getRepository(Bill);

  const admin = userRepository.create({
    username: "admin",
    password: "admin123456",
    role: UserRole.ADMIN,
    balance: 1000,
  });
  await userRepository.save(admin);
  console.log("Created admin user");

  const plans = [
    planRepository.create({
      name: "Free",
      type: PlanType.FREE,
      price: 0,
      discount: 0,
      description: "Free plan with limited features",
    }),
    planRepository.create({
      name: "Monthly Basic",
      type: PlanType.MONTHLY,
      price: 29.99,
      discount: 0,
      description: "Monthly subscription plan",
    }),
    planRepository.create({
      name: "Quarterly Pro",
      type: PlanType.QUARTERLY,
      price: 79.99,
      discount: 10,
      description: "Quarterly subscription with 10% discount",
    }),
    planRepository.create({
      name: "Yearly Premium",
      type: PlanType.YEARLY,
      price: 299.99,
      discount: 20,
      description: "Yearly subscription with 20% discount",
    }),
  ];
  await planRepository.save(plans);
  console.log("Created 4 subscription plans");

  const users: User[] = [];
  for (let i = 1; i <= 5; i++) {
    const user = userRepository.create({
      username: `user${i}`,
      password: "user123456",
      role: UserRole.USER,
      balance: 100 + i * 50,
    });
    await userRepository.save(user);
    users.push(user);
  }
  console.log("Created 5 test users");

  const statuses = [
    SubscriptionStatus.ACTIVE,
    SubscriptionStatus.ACTIVE,
    SubscriptionStatus.EXPIRED,
    SubscriptionStatus.CANCELLED,
    SubscriptionStatus.TRIAL,
  ];

  const subscriptions: Subscription[] = [];
  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    const plan = plans[i % plans.length];
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 15 - i * 5);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + plan.getDurationDays());

    const subscription = subscriptionRepository.create({
      user,
      plan,
      startDate,
      endDate,
      autoRenew: i % 2 === 0,
      status: statuses[i],
    });
    await subscriptionRepository.save(subscription);
    subscriptions.push(subscription);

    const bill = billRepository.create({
      user,
      subscription,
      plan,
      amount: plan.getActualPrice(),
      status: BillStatus.PAID,
      description: `Subscription to ${plan.name}`,
      paidAt: startDate,
      createdAt: startDate,
    });
    await billRepository.save(bill);
  }
  console.log("Created subscriptions and billing history");

  console.log("\n=== Seed Data Complete ===");
  console.log("Admin: admin / admin123456");
  console.log("Users: user1-user5 / user123456");
  console.log("Plans: Monthly ($29.99), Quarterly ($71.99), Yearly ($239.99)");
  console.log("\nRun 'npm run dev' to start the server");

  process.exit(0);
};

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
