import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;
  let appService: { getHealth: jest.Mock };

  beforeEach(async () => {
    appService = {
      getHealth: jest.fn(),
    };

    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        {
          provide: AppService,
          useValue: appService,
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return health payload', async () => {
      const payload = {
        service: 'myride-api',
        status: 'ok',
      };
      appService.getHealth.mockResolvedValue(payload);

      await expect(appController.getHealth()).resolves.toEqual(payload);
    });
  });
});
