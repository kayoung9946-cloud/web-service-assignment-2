import { AppError, missing, forbidden, invalidState } from './errors.js';

function runInTransaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 이미 SQLite 내부에서 롤백된 경우 무시하고 원래 오류를 전달합니다.
    }
    throw err;
  }
}

export function createApplicationService(repo) {
  return {
    apply(actor, eventId) {
      return runInTransaction(repo.db, () => {
        const event = repo.event(eventId);
        if (!event) throw missing('행사');

        if (actor.role !== 'STUDENT') throw forbidden();

        const duplicated = repo.existing(eventId, actor.id);
        if (duplicated) {
          throw new AppError(409, 'ALREADY_APPLIED', '이미 신청한 행사입니다.');
        }

        let created;
        try {
          created = repo.insert(eventId, actor.id);
        } catch (err) {
          if (err?.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/i.test(err.message)) {
            throw new AppError(409, 'ALREADY_APPLIED', '이미 신청한 행사입니다.');
          }
          throw err;
        }

        repo.addHistory({
          applicationId: created.id,
          actorId: actor.id,
          action: 'APPLY',
          fromStatus: null,
          toStatus: 'PENDING',
          reason: null,
          causeHistoryId: null,
        });

        return created;
      });
    },

    cancel(actor, applicationId) {
      return runInTransaction(repo.db, () => {
        const app = repo.application(applicationId);
        if (!app) throw missing('신청');

        if (actor.role !== 'STUDENT' || app.userId !== actor.id) {
          throw forbidden();
        }

        if (app.status !== 'PENDING') {
          throw invalidState();
        }

        const updated = repo.setStatus(applicationId, 'CANCELLED');
        repo.addHistory({
          applicationId,
          actorId: actor.id,
          action: 'CANCEL',
          fromStatus: 'PENDING',
          toStatus: 'CANCELLED',
          reason: null,
          causeHistoryId: null,
        });

        return updated;
      });
    },

    approve(actor, applicationId) {
      return runInTransaction(repo.db, () => {
        const app = repo.application(applicationId);
        if (!app) throw missing('신청');

        const event = repo.event(app.eventId);
        if (actor.role !== 'MANAGER' || !event || event.managerId !== actor.id) {
          throw forbidden();
        }

        if (app.status !== 'PENDING') {
          throw invalidState();
        }

        if (repo.approvedCount(event.id) >= event.capacity) {
          throw new AppError(409, 'CAPACITY_FULL', '행사 정원이 가득 찼습니다.');
        }

        const updated = repo.setStatus(applicationId, 'APPROVED');
        repo.addHistory({
          applicationId,
          actorId: actor.id,
          action: 'APPROVE',
          fromStatus: 'PENDING',
          toStatus: 'APPROVED',
          reason: null,
          causeHistoryId: null,
        });

        return updated;
      });
    },

    revoke(actor, applicationId, reason) {
      const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
      if (trimmedReason.length < 5 || trimmedReason.length > 200) {
        throw new AppError(400, 'BAD_INPUT', '승인 취소 사유는 공백 제외 5~200자여야 합니다.');
      }

      return runInTransaction(repo.db, () => {
        const app = repo.application(applicationId);
        if (!app) throw missing('신청');

        const event = repo.event(app.eventId);
        if (actor.role !== 'MANAGER' || !event || event.managerId !== actor.id) {
          throw forbidden();
        }

        if (app.status !== 'APPROVED') {
          throw invalidState();
        }

        const revoked = repo.setStatus(applicationId, 'REVOKED');
        const revokeHistoryId = repo.addHistory({
          applicationId,
          actorId: actor.id,
          action: 'REVOKE',
          fromStatus: 'APPROVED',
          toStatus: 'REVOKED',
          reason: trimmedReason,
          causeHistoryId: null,
        });

        const nextWaiter = repo.nextPending(event.id);
        if (!nextWaiter) {
          return { revoked, promoted: null };
        }

        const promoted = repo.setStatus(nextWaiter.id, 'APPROVED');
        repo.addHistory({
          applicationId: nextWaiter.id,
          actorId: actor.id,
          action: 'AUTO_APPROVE',
          fromStatus: 'PENDING',
          toStatus: 'APPROVED',
          reason: null,
          causeHistoryId: revokeHistoryId,
        });

        return { revoked, promoted };
      });
    },
  };
}
