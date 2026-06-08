import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToOne, JoinColumn } from "typeorm";
import { User } from "./User";

@Entity()
export class Referral {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User)
  referrer: User;

  @OneToOne(() => User)
  @JoinColumn()
  referredUser: User;

  @Column({ type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  createdAt: Date;
}
